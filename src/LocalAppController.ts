// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { findJvm } from "@pivotal-tools/jvm-launch-utils";
import { ChildProcess } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { AppState, BootApp } from "./BootApp";
import { LocalAppManager } from "./LocalAppManager";
import { MainClassData } from "./types/jdtls";
import { constructOpenUrl, isActuatorJarFile, isAlive, readAll } from "./utils";

import getPort = require("get-port");
import { sendInfo } from "vscode-extension-telemetry-wrapper";
import { dashboard } from "./global";

export class LocalAppController {

    constructor(
        private manager: LocalAppManager,
        private context: vscode.ExtensionContext
    ) { }

    public getAppList(): BootApp[] {
        return this.manager.getAppList();
    }

    public async runBootApps(debug?: boolean) {
        const appList = this.getAppList();
        if (appList.length === 1 && appList[0].state !== AppState.RUNNING) {
            this.runBootApp(appList[0], debug);
        } else {
            const appsToRun = await vscode.window.showQuickPick(
                appList.filter(app => app.state !== AppState.RUNNING).map(app => ({ label: app.name, path: app.path })), /** items */
                { canPickMany: true, placeHolder: `Select apps to ${debug ? "debug" : "run"}.` } /** options */
            );
            if (appsToRun !== undefined) {
                const appPaths = appsToRun.map(elem => elem.path);
                await Promise.all(appList.filter(app => appPaths.indexOf(app.path) > -1).map(app => this.runBootApp(app, debug)));
            }
        }
    }

    public async runBootApp(app: BootApp, debug?: boolean, profile?: string): Promise<void> {
        const mainClasData = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Resolving main classes for ${app.name}...` },
            async () => {
                const mainClassList = await app.getLaunchableMainClasses();

                if (mainClassList && mainClassList instanceof Array && mainClassList.length > 0) {
                    return mainClassList.length === 1 ? mainClassList[0] :
                        await vscode.window.showQuickPick(mainClassList.map(x => Object.assign({ label: x.mainClass }, x)), { placeHolder: `Specify the main class for ${app.name}` });
                }
                return null;
            }
        );
        if (mainClasData === null) {
            vscode.window.showWarningMessage("No main class is found.");
            return;
        }
        if (mainClasData === undefined) {
            return;
        }

        const configResource = mainClasData.filePath ? vscode.Uri.file(mainClasData.filePath) : vscode.Uri.parse(app.path);
        let targetConfig = this._getLaunchConfig(mainClasData, configResource);
        if (!targetConfig) {
            targetConfig = await this._createNewLaunchConfig(mainClasData, configResource);
        }
        app.activeSessionName = targetConfig.name;

        targetConfig = await resolveDebugConfigurationWithSubstitutedVariables(targetConfig);
        app.jmxPort = parseJMXPort(targetConfig.vmArgs);

        const cwdUri: vscode.Uri = vscode.Uri.parse(app.path);
        const launchConfig = Object.assign({}, targetConfig, {
            noDebug: !debug,
            cwd: cwdUri.fsPath,
        });
        if (profile) {
            launchConfig.vmArgs = launchConfig.vmArgs + ` -Dspring.profiles.active=${profile}`;
        }

        await vscode.debug.startDebugging(
            vscode.workspace.getWorkspaceFolder(cwdUri),
            launchConfig
        );
    }

    public async runAppWithProfile(app: BootApp, debug?: boolean) {
        const sourceFolders = app.classpath.entries.filter(cpe => cpe.kind === "source").map(cpe => cpe.path);
        const profilePattern = /^(application|bootstrap)-(.*)\.(properties|yml|yaml)$/;
        const detectedProfiles = new Set<string>();
        const foldersToCheck = [...sourceFolders];

        // Add config folders which might contain bootstrap files
        for (const sf of sourceFolders) {
            const configFolder = path.join(sf, 'config');
            foldersToCheck.push(configFolder);
        }

        for (const folder of foldersToCheck) {
            try {
                const uri = vscode.Uri.file(folder);
                const entries = await vscode.workspace.fs.readDirectory(uri);
                const files = entries.filter(f => f[1] === vscode.FileType.File);
                for (const f of files) {
                    const res = profilePattern.exec(f[0]);
                    if (res !== null) {
                        const matchedProfile = res[2]; // Group 2 contains the actual profile name
                        detectedProfiles.add(matchedProfile);
                    }
                }
            } catch (error) {
                console.log(error);
            }
        }
        const selectedProfiles = await vscode.window.showQuickPick(Array.from(detectedProfiles), {
            ignoreFocusOut: true,
            canPickMany: true,
            title: "Select Active Profiles",
            placeHolder: "will add -Dspring.profiles.active=profile1,profile2... to VMArgs"
        });
        if (selectedProfiles !== undefined) {
            const profileArgs = selectedProfiles.join(",");
            await this.runBootApp(app, debug, profileArgs);
        }
    }


    public onDidStartBootApp(session: vscode.DebugSession): void {
        // Match against all known projects (unfiltered): a project whose annotation
        // verification is still pending, or which was just excluded by settings,
        // must not lose its debug session binding — otherwise its running state
        // can never be tracked.
        // exact match
        let app: BootApp | undefined = this.manager.getAllApps().find((elem: BootApp) => elem.activeSessionName === session.name);

        // workaround if not launched from dashboard, where `activeSessionName` is not set
        // See https://github.com/microsoft/vscode-spring-boot-dashboard/issues/177
        if (app === undefined) {
            app = this.manager.getAllApps().find((elem: BootApp) => elem.name === session.configuration.projectName);
        }

        if (app) {
            this.manager.bindDebugSession(app, session);
            if (isActuatorOnClasspath(session.configuration)) {
                // actuator enabled: wait live connection to update running state.
                this._setState(app, AppState.LAUNCHING);
                this._watchLaunchingApp(app);
                sendInfo("", { name: "onDidStartBootApp", withActuator: "true" });
            } else {
                // actuator absent: no live connection, set project as 'running' immediately.
                this._setState(app, AppState.RUNNING);
                // Guide to enable actuator
                this.showActuatorGuideIfNecessary(app);
                sendInfo("", { name: "onDidStartBootApp", withActuator: "false" });
            }
        }
    }

    /**
     * Fallback for apps whose live-process connection never arrives.
     *
     * When several services start concurrently (typical for a microservice
     * workspace), the spring-boot extension's process discovery can miss the
     * freshly spawned JVM — it resolves the java child of the launch shell once,
     * and under load that child appears after the lookup — so no live connection
     * is ever established and the app would spin in "launching" forever, even
     * though it is fully up (see the console output).
     *
     * Until the live connection takes over, poll the app's JMX endpoint (each
     * launch config gets a unique jmxremote.port) and flip the app to "running"
     * as soon as its web server reports a port. Without a JMX port, fall back to
     * checking that the debug session's process is still alive, so the state at
     * least stops spinning.
     */
    private _watchLaunchingApp(app: BootApp): void {
        const POLL_INTERVAL_MS = 5 * 1000;
        const MAX_POLLS = 60; // ~5 minutes
        let polls = 0;
        const watchdog: NodeJS.Timeout = setInterval(async () => {
            if (app.state !== AppState.LAUNCHING) {
                // live process connected (or the app stopped) — the fallback is off duty.
                clearInterval(watchdog);
                return;
            }
            if (this.manager.getSessionByApp(app) === undefined) {
                clearInterval(watchdog);
                return;
            }
            if (++polls > MAX_POLLS) {
                clearInterval(watchdog);
                return;
            }

            try {
                const serverInfo = await this._queryJmxServerInfo(app);
                if (serverInfo) {
                    clearInterval(watchdog);
                    app.port = serverInfo.port;
                    app.contextPath = serverInfo.contextPath;
                    this._setState(app, AppState.RUNNING);
                } else if (app.pid !== undefined && (await isAlive(app.pid)) === false) {
                    // process died without ever serving — back to inactive.
                    clearInterval(watchdog);
                    this._setState(app, AppState.INACTIVE);
                }
            } catch (error) {
                console.log(error);
            }
        }, POLL_INTERVAL_MS);
    }

    public async stopBootApps() {
        const appList = this.getAppList();
        if (appList.length === 1 && appList[0].state !== AppState.INACTIVE) {
            this.stopBootApp(appList[0]);
        } else {
            const appsToStop = await vscode.window.showQuickPick(
                appList.filter(app => app.state !== AppState.INACTIVE).map(app => ({ label: app.name, path: app.path })), /** items */
                { canPickMany: true, placeHolder: "Select apps to stop." } /** options */
            );
            if (appsToStop !== undefined) {
                const appPaths = appsToStop.map(elem => elem.path);
                await Promise.all(appList.filter(app => appPaths.indexOf(app.path) > -1).map(app => this.stopBootApp(app)));
            }
        }
    }

    public async stopBootApp(app: BootApp, restart?: boolean): Promise<void> {
        // TODO: How to send a shutdown signal to the app instead of killing the process directly?
        const session: vscode.DebugSession | undefined = this.manager.getSessionByApp(app);
        if (session) {
            if (isRunInTerminal(session) && app.pid) {
                // kill corresponding process launched in terminal
                try {
                    process.kill(app.pid);
                } catch (error) {
                    console.log(error);
                    app.reset();
                }
            } else {
                await session.customRequest("disconnect", { restart: !!restart });
            }
        }
    }

    public onDidStopBootApp(session: vscode.DebugSession): void {
        const app = this.manager.getAppBySession(session);
        if (app) {
            this._setState(app, AppState.INACTIVE);
        }
    }

    /**
     * Queries a locally running app's JMX endpoint (see the vmArgs added in
     * `resolveDebugConfigurationWithSubstitutedVariables`) and returns its server
     * port and context path. `undefined` when the app has no JMX port or the
     * JVM is not reachable (e.g. not started yet).
     */
    private async _queryJmxServerInfo(app: BootApp): Promise<{ port: number, contextPath: string } | undefined> {
        if (!app.jmxPort) {
            return undefined;
        }

        const jvm = await findJvm();
        if (!jvm) {
            return undefined;
        }

        const jmxurl = `service:jmx:rmi:///jndi/rmi://localhost:${app.jmxPort}/jmxrmi`;
        const javaProcess = jvm.jarLaunch(
            path.resolve(this.context.extensionPath, "lib", "java-extension.jar"),
            [
                "-Djmxurl=" + jmxurl
            ]
        );
        const stdout = javaProcess.stdout ? await readAll(javaProcess.stdout) : null;

        let port: number | undefined = undefined;
        let contextPath: string | undefined = undefined;

        READ_JMX_EXTENSION_RESPONSE: {
            if (stdout !== null) {
                let jmxExtensionResponse;

                try {
                    jmxExtensionResponse = JSON.parse(stdout);
                } catch (ex) {
                    console.log(ex);
                    break READ_JMX_EXTENSION_RESPONSE;
                }

                if (jmxExtensionResponse['local.server.port'] !== null && typeof jmxExtensionResponse['local.server.port'] === 'number') {
                    port = jmxExtensionResponse['local.server.port'];
                }

                if (jmxExtensionResponse['server.servlet.context-path'] !== null) {
                    contextPath = jmxExtensionResponse['server.servlet.context-path'];
                }

                if (jmxExtensionResponse['status'] !== null && jmxExtensionResponse['status'] === "failure") {
                    this._printJavaProcessError(javaProcess);
                }
            }
        }

        if (contextPath === undefined) {
            contextPath = ""; //if no context path is defined then fallback to root path
        }

        return port !== undefined ? { port, contextPath } : undefined;
    }

    private async getOpenUrlFromJMX(app: BootApp) {
        const serverInfo = await this._queryJmxServerInfo(app);
        return serverInfo ? constructOpenUrl(serverInfo.contextPath, serverInfo.port) : undefined;
    }

    public async openBootApp(app: BootApp): Promise<void> {
        let openUrl: string | undefined;
        if (app.contextPath !== undefined && app.port !== undefined) {
            openUrl = constructOpenUrl(app.contextPath, app.port);
        } else {
            openUrl = await this.getOpenUrlFromJMX(app);
        }

        if (openUrl !== undefined) {
            const openWithExternalBrowser: boolean = vscode.workspace.getConfiguration("spring.dashboard").get("openWith") === "external";
            const browserCommand: string = openWithExternalBrowser ? "vscode.open" : "simpleBrowser.api.open";

            let uri = vscode.Uri.parse(openUrl);
            uri = await vscode.env.asExternalUri(uri); // Enables Remote envs like Codespaces
            vscode.commands.executeCommand(browserCommand, uri);
        } else {
            vscode.window.showErrorMessage("Couldn't determine port app is running on");
        }
    }

    private async _printJavaProcessError(javaProcess: ChildProcess) {
        if (javaProcess.stderr) {
            const err = await readAll(javaProcess.stderr);
            console.log(err);
        }
    }

    private _setState(app: BootApp, state: AppState): void {
        app.state = state;
        this.manager.fireDidChangeApps(app);
        dashboard.beansProvider.refresh(app);
        dashboard.mappingsProvider.refresh(app);
    }

    private _getLaunchConfig(mainClasData: MainClassData, configResource: vscode.Uri) {
        const launchConfigurations: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("launch", configResource);
        const rawConfigs: vscode.DebugConfiguration[] = launchConfigurations.configurations;
        return rawConfigs.find(conf => conf.type === "java" && conf.request === "launch" && conf.mainClass === mainClasData.mainClass && conf.projectName === mainClasData.projectName);
    }

    private _constructLaunchConfigName(mainClass: string, projectName: string) {
        const prefix = "Spring Boot-";
        let name = prefix + mainClass.substr(mainClass.lastIndexOf(".") + 1);
        if (projectName !== undefined) {
            name += `<${projectName}>`;
        }
        return name;
    }

    private async _createNewLaunchConfig(mainClasData: MainClassData, configResource: vscode.Uri): Promise<vscode.DebugConfiguration> {
        const newConfig = {
            type: "java",
            name: this._constructLaunchConfigName(mainClasData.mainClass, mainClasData.projectName),
            request: "launch",
            cwd: "${workspaceFolder}",
            mainClass: mainClasData.mainClass,
            projectName: mainClasData.projectName,
            args: "",
            envFile: "${workspaceFolder}/.env"
        };
        const launchConfigurations: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration("launch", configResource);
        const configs: vscode.DebugConfiguration[] = launchConfigurations.configurations;
        configs.push(newConfig);
        await launchConfigurations.update("configurations", configs, vscode.ConfigurationTarget.WorkspaceFolder);
        return newConfig;
    }

    private showActuatorGuideIfNecessary(app: BootApp) {
        const command = "spring.promptToEnableActuator";
        const key = "LastTimeSeenActuatorGuide";

        const lastMonth = new Date();
        lastMonth.setMonth(lastMonth.getMonth() - 1);

        const lastTimeSeen: number = this.context.globalState.get(key) ?? 0;
        if (new Date(lastTimeSeen) < lastMonth) {
            this.context.globalState.update(key, Date.now());
            vscode.commands.executeCommand(command, app, true /* asNotification */);
        }
    }

}

function isRunInTerminal(session: vscode.DebugSession) {
    return session.configuration.noDebug === true && session.configuration.console !== "internalConsole";
}

function isActuatorOnClasspath(debugConfiguration: vscode.DebugConfiguration): boolean {
    if (Array.isArray(debugConfiguration.classPaths)) {
        return !!debugConfiguration.classPaths.find(isActuatorJarFile);
    }
    return false;
}

async function resolveDebugConfigurationWithSubstitutedVariables(debugConfiguration: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration> {
    if (!debugConfiguration.vmArgs) {
        debugConfiguration.vmArgs = "";
    } else if (debugConfiguration.vmArgs instanceof Array) {
        debugConfiguration.vmArgs = debugConfiguration.vmArgs.join(" ");
    }

    // Add default vmArgs if not specified
    if (debugConfiguration.vmArgs.indexOf("-Dcom.sun.management.jmxremote") < 0) {
        debugConfiguration.vmArgs += " -Dcom.sun.management.jmxremote";
    }
    if (debugConfiguration.vmArgs.indexOf("-Dcom.sun.management.jmxremote.port") < 0) {
        const jmxport = await getPort();
        debugConfiguration.vmArgs += ` -Dcom.sun.management.jmxremote.port=${jmxport}`;
    }
    if (debugConfiguration.vmArgs.indexOf("-Dcom.sun.management.jmxremote.authenticate=") < 0) {
        debugConfiguration.vmArgs += " -Dcom.sun.management.jmxremote.authenticate=false";
    }
    if (debugConfiguration.vmArgs.indexOf("-Dcom.sun.management.jmxremote.ssl=") < 0) {
        debugConfiguration.vmArgs += " -Dcom.sun.management.jmxremote.ssl=false";
    }
    if (debugConfiguration.vmArgs.indexOf("-Dspring.jmx.enabled=") < 0) {
        debugConfiguration.vmArgs += " -Dspring.jmx.enabled=true";
    }
    if (debugConfiguration.vmArgs.indexOf("-Djava.rmi.server.hostname=") < 0) {
        debugConfiguration.vmArgs += " -Djava.rmi.server.hostname=localhost";
    }
    if (debugConfiguration.vmArgs.indexOf("-Dspring.application.admin.enabled=") < 0) {
        debugConfiguration.vmArgs += " -Dspring.application.admin.enabled=true";
    }
    if (debugConfiguration.vmArgs.indexOf("-Dspring.boot.project.name=") < 0) {
        debugConfiguration.vmArgs += ` -Dspring.boot.project.name=${debugConfiguration.projectName}`;
    }


    return debugConfiguration;
}

function parseJMXPort(vmArgs: string): number | undefined {
    const matched = vmArgs.match(/-Dcom\.sun\.management\.jmxremote\.port=\d+/);
    if (matched) {
        const port = matched[0].substring("-Dcom.sun.management.jmxremote.port=".length);
        return parseInt(port);
    }
    return undefined;
}
