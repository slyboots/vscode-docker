import vscode = require('vscode');
import * as path from 'path';
import * as fs from 'fs';
import * as pomParser from 'pom-parser';
import * as gradleParser from 'gradle-to-js/lib/parser';
import { promptForPort, quickPickPlatform } from './config-utils';
import { reporter } from '../telemetry/telemetry';

function genDockerFile(serviceName: string, platform: string, port: string, { cmd, author, version, artifactName }: PackageJson): string {
    switch (platform.toLowerCase()) {
        case 'node.js':

            return `FROM node:8.9-alpine
ENV NODE_ENV production
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --production --silent && mv node_modules ../
COPY . .
EXPOSE ${port}
CMD ${cmd}`;

        case 'go':

            return `
#build stage
FROM golang:alpine AS builder
WORKDIR /go/src/app
COPY . .
RUN apk add --no-cache git
RUN go-wrapper download   # "go get -d -v ./..."
RUN go-wrapper install    # "go install -v ./..."

#final stage
FROM alpine:latest
RUN apk --no-cache add ca-certificates
COPY --from=builder /go/bin/app /app
ENTRYPOINT ./app
LABEL Name=${serviceName} Version=${version}
EXPOSE ${port}
`;

        case '.net core':

            return `
FROM microsoft/aspnetcore:1
LABEL Name=${serviceName} Version=${version}
ARG source=.
WORKDIR /app
EXPOSE ${port}
COPY $source .
ENTRYPOINT dotnet ${serviceName}.dll
`;

        case 'python':

            return `
# Python support can be specified down to the minor or micro version
# (e.g. 3.6 or 3.6.3).
# OS Support also exists for jessie & stretch (slim and full).
# See https://hub.docker.com/r/library/python/ for all supported Python
# tags from Docker Hub.
FROM python:alpine

# If you prefer miniconda:
#FROM continuumio/miniconda3

LABEL Name=${serviceName} Version=${version}
EXPOSE ${port}

WORKDIR /app
ADD . /app

# Using pip:
RUN python3 -m pip install -r requirements.txt
CMD ["python3", "-m", "${serviceName}"]

# Using pipenv:
#RUN python3 -m pip install pipenv
#RUN pipenv install --ignore-pipfile
#CMD ["pipenv", "run", "python3", "-m", "${serviceName}"]

# Using miniconda (make sure to replace 'myenv' w/ your environment name):
#RUN conda env create -f environment.yml
#CMD /bin/bash -c "source activate myenv && python3 -m ${serviceName}"
`;

        case 'java':
            const artifact = artifactName ? artifactName : `${serviceName}.jar`;
            return `
FROM openjdk:8-jdk-alpine
VOLUME /tmp
ARG JAVA_OPTS
ENV JAVA_OPTS=$JAVA_OPTS
ADD ${artifact} ${serviceName}.jar
EXPOSE ${port}
ENTRYPOINT exec java $JAVA_OPTS -jar ${serviceName}.jar
# For Spring-Boot project, use the entrypoint below to reduce Tomcat startup time.
#ENTRYPOINT exec java $JAVA_OPTS -Djava.security.egd=file:/dev/./urandom -jar ${serviceName}.jar
`;

        default:

            return `
FROM docker/whalesay:latest
LABEL Name=${serviceName} Version=${version}
RUN apt-get -y update && apt-get install -y fortunes
CMD /usr/games/fortune -a | cowsay
`;
    }
}

function genDockerCompose(serviceName: string, platform: string, port: string): string {
    switch (platform.toLowerCase()) {
        case 'node.js':
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build: .
    environment:
      NODE_ENV: production
    ports:
      - ${port}:${port}`;

        case 'go':
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build: .
    ports:
      - ${port}:${port}`;

        case '.net core':
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build: .
    ports:
      - ${port}:${port}`;

        case 'python':
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build: .
    ports:
      - ${port}:${port}`;

        case 'java':
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build: .
    ports:
      - ${port}:${port}`;

        default:
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build: .
    ports:
      - ${port}:${port}`;
    }
}

function genDockerComposeDebug(serviceName: string, platform: string, port: string, { fullCommand: cmd }: PackageJson): string {
    switch (platform.toLowerCase()) {
        case 'node.js':

            const cmdArray: string[] = cmd.split(' ');
            if (cmdArray[0].toLowerCase() === 'node') {
                cmdArray.splice(1, 0, '--inspect=0.0.0.0:9229');
                cmd = `command: ${cmdArray.join(' ')}`;
            } else {
                cmd = '## set your startup file here\n    command: node --inspect index.js';
            }

            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build: .
    environment:
      NODE_ENV: development
    ports:
      - ${port}:${port}
      - 9229:9229
    ${cmd}`;

        case 'go':
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build:
      context: .
      dockerfile: Dockerfile
    ports:
        - ${port}:${port}
`;

        case '.net core':
            return `version: '2.1'

services:
  ${serviceName}:
    build:
      args:
        source: obj/Docker/empty/
    labels:
      - "com.microsoft.visualstudio.targetoperatingsystem=linux"
    environment:
      - ASPNETCORE_ENVIRONMENT=Development
      - DOTNET_USE_POLLING_FILE_WATCHER=1
    volumes:
      - .:/app
      - ~/.nuget/packages:/root/.nuget/packages:ro
      - ~/clrdbg:/clrdbg:ro
    entrypoint: tail -f /dev/null
`;

        case 'python':
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build:
      context: .
      dockerfile: Dockerfile
    ports:
        - ${port}:${port}
`;

        case 'java':
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      JAVA_OPTS: -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005,quiet=y
    ports:
      - ${port}:${port}
      - 5005:5005
    `;

        default:
            return `version: '2.1'

services:
  ${serviceName}:
    image: ${serviceName}
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - ${port}:${port}
`;
    }
}

function genDockerIgnoreFile(service, platformType, port) {
    // TODO: Add support for other platform types
    return `node_modules
npm-debug.log
Dockerfile*
docker-compose*
.dockerignore
.git
.gitignore
README.md
LICENSE
.vscode`;
}

interface PackageJson {
    npmStart: boolean, //has npm start
    cmd: string,
    fullCommand: string, //full command
    author: string,
    version: string,
    artifactName: string
}

async function getPackageJson(folder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles(new vscode.RelativePattern(folder, 'package.json'), null, 1, null);
}

function getDefaultPackageJson(): PackageJson {
    return {
        npmStart: true,
        fullCommand: 'npm start',
        cmd: 'npm start',
        author: 'author',
        version: '0.0.1',
        artifactName: ''
    };
}

async function readPackageJson(folder: vscode.WorkspaceFolder): Promise<PackageJson> {
    // open package.json and look for main, scripts start
    const uris: vscode.Uri[] = await getPackageJson(folder);
    var pkg: PackageJson = getDefaultPackageJson(); //default

    if (uris && uris.length > 0) {
        const json = JSON.parse(fs.readFileSync(uris[0].fsPath, 'utf8'));

        if (json.scripts && json.scripts.start) {
            pkg.npmStart = true;
            pkg.fullCommand = json.scripts.start;
            pkg.cmd = 'npm start';
        } else if (json.main) {
            pkg.npmStart = false;
            pkg.fullCommand = 'node' + ' ' + json.main;
            pkg.cmd = pkg.fullCommand;
        } else {
            pkg.fullCommand = '';
        }

        if (json.author) {
            pkg.author = json.author;
        }

        if (json.version) {
            pkg.version = json.version;
        }
    }

    return pkg;
}

async function readPomOrGradle(folder: vscode.WorkspaceFolder): Promise<PackageJson> {
    var pkg: PackageJson = getDefaultPackageJson(); //default

    if (fs.existsSync(path.join(folder.uri.fsPath, 'pom.xml'))) {
        const json = await new Promise<any>((resolve, reject) => {
            pomParser.parse({
                filePath: path.join(folder.uri.fsPath, 'pom.xml')
            }, (error, response) => {
                if (error) {
                    reject(`Failed to parse pom.xml: ${error}`);
                    return;
                }
                resolve(response.pomObject);
            });
        });

        if (json.project.version) {
            pkg.version = json.project.version;
        }

        if (json.project.artifactid) {
            pkg.artifactName = `target/${json.project.artifactid}-${pkg.version}.jar`;
        }
    } else if (fs.existsSync(path.join(folder.uri.fsPath, 'build.gradle'))) {
        const json = await gradleParser.parseFile(path.join(folder.uri.fsPath, 'build.gradle'));

        if (json.jar && json.jar.version) {
            pkg.version = json.jar.version;
        } else if (json.version) {
            pkg.version = json.version;
        }

        if (json.jar && json.jar.archiveName) {
            pkg.artifactName = `build/libs/${json.jar.archiveName}`;
        } else {
            const baseName = json.jar && json.jar.baseName ? json.jar.baseName : json.archivesBaseName || folder.name;
            pkg.artifactName = `build/libs/${baseName}-${pkg.version}.jar`;
        }
    }

    return pkg;
}

const DOCKER_FILE_TYPES = {
    'docker-compose.yml': genDockerCompose,
    'docker-compose.debug.yml': genDockerComposeDebug,
    'Dockerfile': genDockerFile,
    '.dockerignore': genDockerIgnoreFile
};

const YES_OR_NO_PROMPT: vscode.MessageItem[] = [
    {
        "title": 'Yes',
        "isCloseAffordance": false
    },
    {
        "title": 'No',
        "isCloseAffordance": true
    }
];

export async function configure(): Promise<void> {
    let folder: vscode.WorkspaceFolder;
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length === 1) {
        folder = vscode.workspace.workspaceFolders[0];
    } else {
        folder = await (<any>vscode).window.showWorkspaceFolderPick();
    }

    if (!folder) {
        if (!vscode.workspace.workspaceFolders) {
            vscode.window.showErrorMessage('Docker files can only be generated if VS Code is opened on a folder.');
        } else {
            vscode.window.showErrorMessage('Docker files can only be generated if a workspace folder is picked in VS Code.');
        }
        return;
    }

    const platformType = await quickPickPlatform();
    if (!platformType) return;

    const port = await promptForPort();
    if (!port) return;

    const serviceName = path.basename(folder.uri.fsPath).toLowerCase();
    let pkg: PackageJson = getDefaultPackageJson();
    if (platformType.toLowerCase() === 'java') {
        pkg = await readPomOrGradle(folder);
    } else {
        pkg = await readPackageJson(folder);
    }

    await Promise.all(Object.keys(DOCKER_FILE_TYPES).map((fileName) => {
        return createWorkspaceFileIfNotExists(fileName, DOCKER_FILE_TYPES[fileName]);
    }));

    /* __GDPR__
       "command" : {
          "command" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" },
          "platformType": { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
       }
     */
    reporter && reporter.sendTelemetryEvent('command', {
        command: 'vscode-docker.configure',
        platformType
    });

    async function createWorkspaceFileIfNotExists(fileName, writerFunction) {
        const workspacePath = path.join(folder.uri.fsPath, fileName);
        if (fs.existsSync(workspacePath)) {
            const item: vscode.MessageItem = await vscode.window.showErrorMessage(`A ${fileName} already exists. Would you like to override it?`, ...YES_OR_NO_PROMPT);
            if (item.title.toLowerCase() === 'yes') {
                fs.writeFileSync(workspacePath, writerFunction(serviceName, platformType, port, pkg), { encoding: 'utf8' });
            }
        } else {
            fs.writeFileSync(workspacePath, writerFunction(serviceName, platformType, port, pkg), { encoding: 'utf8' });
        }
    }
}
