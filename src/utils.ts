// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.

import * as minimatch from "minimatch";
import * as path from "path";
import { Readable } from "stream";
import * as vscode from "vscode";
import { ClassPathData, MainClassData } from "./types/jdtls";

type PidtreeModule = typeof import("pidtree");
type PidtreeLoader = () => Promise<PidtreeModule>;

declare const WEBPACK_BUNDLED: boolean;

const importPidtree = new Function("specifier", "return import(specifier);") as
    (specifier: string) => Promise<PidtreeModule>;

async function loadPidtree(): Promise<PidtreeModule> {
    if (typeof WEBPACK_BUNDLED !== "undefined" && WEBPACK_BUNDLED) {
        return import("pidtree");
    }

    // TypeScript rewrites import() to require() for CommonJS output, so keep
    // the native import intact for ESM-only pidtree in unbundled test builds.
    return importPidtree("pidtree");
}
export function readAll(input: Readable): Promise<string> {
    let buffer = "";
    return new Promise<string>((resolve, reject) => {
        input.on('data', data => {
            buffer += data;
        });
        input.on('error', error => {
            reject(error);
        });
        input.on('end', () => {
            resolve(buffer.toString());
        });

    });
}

export async function isAlive(pid?: number, pidtreeLoader: PidtreeLoader = loadPidtree): Promise<boolean | undefined> {
    if (!pid) {
        return false;
    }

    try {
        const { pidtree } = await pidtreeLoader();
        const pidList = await pidtree(-1);
        return pidList.includes(pid);
    } catch (error) {
        console.error(`Failed to determine whether process ${pid} is alive.`, error);
        return undefined;
    }
}


export async function sleep(ms: number) {
    return new Promise<void>((resolve) => {
        setTimeout(() => {
            resolve();
        }, ms);
    });
}

export function isActuatorJarFile(f: string): boolean {
    const fileName = path.basename(f || "");
    if (/^spring-boot-actuator-\d+\.\d+\.\d+(.*)?.jar$/.test(fileName)) {
        return true;
    }
    return false;
}

/**
 * Whether `filePath` is located strictly inside `folder` (excluding the folder
 * itself). Both are expected to be absolute file system paths.
 */
function isInFolder(filePath: string, folder: string): boolean {
    const relative = path.relative(folder, filePath);
    // An empty result means both point at the same location, a leading ".."
    // segment means filePath is outside, and an absolute result means they are
    // on different drives.
    return !!relative
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

type TestFileClassifier = (filePath: string) => Promise<boolean>;

async function isJavaTestFile(filePath: string): Promise<boolean> {
    return await vscode.commands.executeCommand<boolean>(
        "java.execute.workspaceCommand",
        "java.project.isTestFile",
        vscode.Uri.file(filePath).toString()
    ) === true;
}

/**
 * Drops the main classes that live in a test source folder of the project.
 *
 * `vscode.java.resolveMainClass` searches all source folders, so a
 * `@SpringBootApplication` class copied into `src/test/java` (a common pattern for
 * integration tests) shows up as an additional candidate to launch. Those classes
 * are not what users want to run from the dashboard, and offering them turns a
 * one-click "run" into a quick pick with irrelevant choices.
 *
 * See https://github.com/microsoft/vscode-spring-boot-dashboard/issues/420
 */
export async function excludeTestMainClasses(
    mainClasses: MainClassData[],
    classpath: ClassPathData,
    classifyTestFile: TestFileClassifier = isJavaTestFile
): Promise<MainClassData[]> {
    const sourceFolders = (classpath?.entries ?? [])
        .filter(cpe => cpe.kind === "source");
    const testSourceFolders = sourceFolders.filter(cpe => cpe.isTest);
    if (testSourceFolders.length === 0) {
        return mainClasses;
    }

    const testMainClasses = await Promise.all(mainClasses.map(async mc => {
        const filePath = mc.filePath;
        if (!filePath) {
            return false;
        }
        if (testSourceFolders.some(cpe => isInFolder(filePath, cpe.path))) {
            return true;
        }
        if (sourceFolders.some(cpe => isInFolder(filePath, cpe.path))) {
            return false;
        }

        // Linked source folders can have different logical and physical paths.
        try {
            return await classifyTestFile(filePath);
        } catch {
            return false;
        }
    }));

    return mainClasses.filter((_, index) => !testMainClasses[index]);
}

/**
 * Construct URL based on format defined in spring.dashboard.openUrl
 *
 * @param contextPath
 * @param portString
 * @param pathSeg must starts with '/'
 * @param hostname
 * @returns url
 */
export function constructOpenUrl(contextPath: string, portString: number | string, pathSeg?: string, hostname?: string) {
    const configOpenUrl: string | undefined = vscode.workspace.getConfiguration("spring.dashboard").get<string>("openUrl");
    let openUrl: string;
    const port = Number(portString);
    if (configOpenUrl === undefined) {
        openUrl = `http${port === 443 ? "s" : ""}://${hostname ?? "localhost"}:${port}${contextPath}`;
    } else {
        openUrl = configOpenUrl
            .replace("{protocol}", port === 443 ? "https" : "http")
            .replace("{hostname}", hostname ?? "localhost")
            .replace("{port}", String(port))
            .replace("{contextPath}", contextPath.toString());
    }
    return `${openUrl}${pathSeg ?? "/"}`;
}

export async function showFilterInView(viewId: string) {
    await vscode.commands.executeCommand(`${viewId}.focus`);
    await vscode.commands.executeCommand("list.find");
}

/**
 * Whether a project is hidden from the dashboard by the `spring.dashboard.excludeApps`
 * setting. Each glob pattern is matched against the project name, the raw project
 * location reported by the Java language server, and its decoded file system path,
 * so both plain project-name and path-style patterns work.
 */
export function isAppExcluded(name: string, appPath: string): boolean {
    const patterns: string[] = vscode.workspace.getConfiguration("spring.dashboard").get("excludeApps") ?? [];
    if (patterns.length === 0) {
        return false;
    }
    const candidates = [name, appPath];
    if (/^[a-z]+:/i.test(appPath)) {
        // jdt.ls reports project locations as URIs in some setups.
        candidates.push(vscode.Uri.parse(appPath).fsPath);
    }
    // `matchBase: true` keeps name-only patterns matching by name alone. With it,
    // minimatch only tries a slash-free pattern (e.g. `*-samples`) against the
    // basename of a path candidate; otherwise `*` collapses to `[^/]*?` and such a
    // pattern would match the full path `/ws/demo-samples`, silently hiding
    // unrelated projects whose parent directory happens to end with `-samples`.
    // Path-style patterns keep working because they contain `/` and are matched in full.
    const options = { dot: true, matchBase: true } as const;
    return patterns.some(pattern => candidates.some(candidate => minimatch(candidate, pattern, options)));
}

const SPRING_BOOT_APPLICATION_ANNOTATION = /@\s*(?:[\w.]+\.)?SpringBootApplication\b/;

/**
 * Whether any of the given main classes is annotated with `@SpringBootApplication`.
 *
 * Used by the `annotation` app detection mode to tell runnable apps from library
 * modules that only have an indirect dependency on Spring Boot (e.g. via
 * spring-cloud-starter-openfeign): those have no main class at all, and even when a
 * plain `public static void main` exists it is not a bootable application.
 *
 * A main class whose source file cannot be read (missing path, IO error) counts as
 * verified, so a broken language server never hides a real app.
 */
export async function hasSpringBootApplication(mainClasses: MainClassData[]): Promise<boolean> {
    for (const mc of mainClasses) {
        if (!mc.filePath) {
            return true;
        }
        try {
            const content = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(mc.filePath))).toString("utf-8");
            if (SPRING_BOOT_APPLICATION_ANNOTATION.test(content)) {
                return true;
            }
        } catch {
            return true;
        }
    }
    return false;
}

export function processKey(appData: {host: string, jmxurl: string}) {
    return `remote process - ${appData.jmxurl}`;
}