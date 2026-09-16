// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import { AppState, BootApp } from "./BootApp";

import * as path from 'path';
import * as uuid from 'uuid';
import * as vscode from 'vscode';
import { DebugSession } from "vscode";
import { initSymbols } from "./controllers/SymbolsController";
import { dashboard } from "./global";
import { ExtensionAPI } from "./types/javaExtensionApi";
import { ClassPathData, MainClassData } from "./types/jdtls";
import { hasSpringBootApplication, isAppExcluded, sleep } from "./utils";

export type AppDetectionMode = "classpath" | "annotation";

function getAppDetectionMode(): AppDetectionMode {
    return vscode.workspace.getConfiguration("spring.dashboard").get<AppDetectionMode>("appDetection") ?? "classpath";
}

const SPRING_BOOT_JAR_PREFIXES = ['spring-boot', 'spring-beans'];
function isBootAppClasspath(cp: ClassPathData): boolean {
    if (cp.entries) {
        const entries = cp.entries;
        for (let i = 0; i < entries.length; i++) {
            const cpe = entries[i];
            const filename = path.basename(cpe.path);
            if (
                filename.endsWith('.jar') &&
                SPRING_BOOT_JAR_PREFIXES.some(prefix => filename.startsWith(prefix))
            ) {
                return true;
            }
        }
    }
    return false;
}

export class LocalAppManager {

    private _boot_projects: Map<string, BootApp> = new Map();
    // project locations that FAILED the @SpringBootApplication verification, see `appDetection`.
    // Apps not in this set are treated as unverified-yet-visible (show first, remove later).
    private _rejectedBootApps: Set<string> = new Set();
    private _bindedSessions: Map<string, DebugSession> = new Map();
    private _onDidChangeApps: vscode.EventEmitter<BootApp | undefined> = new vscode.EventEmitter<BootApp | undefined>();
    constructor() {
        //We have to do something with the errors here because constructor cannot
        // be declared as `async`.
        this._startAppListSynchronisation()
            .catch((error) => {
                console.error(error);
            });
    }

    public get onDidChangeApps(): vscode.Event<BootApp | undefined> {
        return this._onDidChangeApps.event;
    }

    public fireDidChangeApps(element: BootApp | undefined): void {
        this._onDidChangeApps.fire(element);
    }

    /**
     * Apps visible to the user: filtered by `spring.dashboard.excludeApps` and, in
     * `annotation` detection mode, by the @SpringBootApplication verification.
     */
    public getAppList(): BootApp[] {
        return Array.from(this._boot_projects.values())
            .filter(app => this.isAppVisible(app))
            .sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
    }

    /**
     * All known classpath-matched projects, unfiltered. Used for internal state
     * tracking (debug session binding, live process matching), so that a project
     * which is temporarily invisible — e.g. while its annotation verification is
     * still pending, or right after settings changed — never loses its running
     * state or bound session.
     */
    public getAllApps(): BootApp[] {
        return Array.from(this._boot_projects.values())
            .sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
    }

    /**
     * Whether an app should be exposed to the dashboard and the launching-related
     * commands. Raw classpath matches are always kept in `_boot_projects`, so
     * toggling the settings takes effect on the next tree refresh without waiting
     * for classpath events to be replayed.
     *
     * In `annotation` mode, apps are visible until the verification explicitly
     * rejects them ("show first, remove on negative result"), so language server
     * latency never blanks the view.
     */
    private isAppVisible(app: BootApp): boolean {
        if (isAppExcluded(app.name, app.path)) {
            return false;
        }
        if (getAppDetectionMode() === "annotation") {
            return !this._rejectedBootApps.has(app.path);
        }
        return true;
    }

    /**
     * Verifies a single app against the `annotation` detection mode, i.e. whether
     * it has a main class annotated with @SpringBootApplication. Apps stay visible
     * until verification finishes and are only hidden on a negative result.
     */
    private async _verifyBootApp(app: BootApp): Promise<void> {
        try {
            const mainClasses = await app.getMainClasses();
            if (await hasSpringBootApplication(mainClasses ?? [])) {
                this._rejectedBootApps.delete(app.path);
            } else {
                this._rejectedBootApps.add(app.path);
            }
        } catch (error) {
            // e.g. language server not ready. Keep the app visible to be safe.
            this._rejectedBootApps.delete(app.path);
        }
        this.fireDidChangeApps(undefined);
    }

    /**
     * Re-runs the @SpringBootApplication verification for all known projects.
     * Called when `spring.dashboard.appDetection` changes.
     */
    public async verifyAllBootApps(): Promise<void> {
        if (getAppDetectionMode() !== "annotation") {
            this.fireDidChangeApps(undefined);
            return;
        }
        await Promise.all(Array.from(this._boot_projects.values()).map(app => this._verifyBootApp(app)));
    }

    public getAppBySession(session: DebugSession): BootApp | undefined {
        const location = Array.from(this._bindedSessions.keys()).find(key => this._bindedSessions.get(key) === session);
        if (location) {
            return this._boot_projects.get(location);
        } else {
            return undefined;
        }
    }

    public getSessionByApp(app: BootApp) :DebugSession | undefined {
        return this._bindedSessions.get(app.path);
    }

    public bindDebugSession(app: BootApp, session: DebugSession): void {
        app.activeSessionName = session.name;
        this._bindedSessions.set(app.path, session);
    }

    public getAppByMainClass(mainClass: string): BootApp | undefined {
        return this.getAllApps().find(app => app.mainClasses?.find((mcd: MainClassData) => mcd.mainClass === mainClass));
    }

    public getAppByPid(pid: number | string): BootApp | undefined {
        const pidNumber = typeof pid === "number" ? pid : parseInt(pid);
        return this.getAllApps().find(app => app.pid === pidNumber);
    }

    /**
     * Registers for classpath change events (from redhat.java and vmware.vscode-spring-boot extension).
     * These events are used to keep the list of boot apps in sync with the workspace projects.
     */
    private async _startAppListSynchronisation(): Promise<void> {
        const callbackId = uuid.v4();

        vscode.commands.registerCommand(callbackId, (location: string, name: string, isDeleted: boolean, entries: ClassPathData) => {
            if (isDeleted) {
                this._boot_projects.delete(location);
                this._rejectedBootApps.delete(location);
            } else {
                if (entries && isBootAppClasspath(entries)) {
                    const current: BootApp | undefined = this._boot_projects.get(location);
                    if (current) {
                        current.name = name;
                        current.classpath = entries;
                    } else {
                        this._boot_projects.set(location, new BootApp(location, name, entries, AppState.INACTIVE));
                    }
                    const app = this._boot_projects.get(location);
                    if (app && getAppDetectionMode() === "annotation") {
                        // main classes may have changed together with the classpath.
                        void this._verifyBootApp(app);
                    }
                } else {
                    this._boot_projects.delete(location);
                    this._rejectedBootApps.delete(location);
                }
            }
            this.fireDidChangeApps(undefined);
            // update workspace symbols for beans/mappings
            initSymbols(5000).then(() => {
                dashboard.beansProvider.refresh(undefined);
                dashboard.mappingsProvider.refresh(undefined);
            });
        });

        async function registerClasspathListener(): Promise<void> {
            const MAX_RETRIES = 10;
            const WAIT_IN_SECONDS = 2;
            let available_tries = MAX_RETRIES;
            while (available_tries > 0) {
                available_tries--;
                try {
                    const javaExtApi: ExtensionAPI = await vscode.extensions.getExtension("redhat.java")?.activate();
                    await javaExtApi?.serverReady?.(); // add '?' for compatibility with old versions.
                    await vscode.commands.executeCommand('java.execute.workspaceCommand', 'sts.java.addClasspathListener', callbackId);
                    return;
                } catch (error) {
                    if (available_tries > 0) {
                        await sleep(WAIT_IN_SECONDS * 1000);
                    } else {
                        throw new Error(`Failed to register classpath listener after ${MAX_RETRIES} retries.`);
                    }
                }
            }
        }

        return await registerClasspathListener();
    }
}
