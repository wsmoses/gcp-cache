import * as core from "@actions/core";
import * as io from "@actions/io";
import { Storage as GoogleCloudStorage } from "@google-cloud/storage";
import * as child_process from "child_process";
import * as path from "path";
import { pipeline } from "stream/promises";

async function isZstdAvailable(): Promise<boolean> {
    try {
        const zstdPath = await io.which("zstd", false);
        return !!zstdPath;
    } catch {
        return false;
    }
}

export async function restoreGcsCache(
    gcpBucket: string,
    gcpPrefix: string = "",
    paths: string[],
    primaryKey: string,
    restoreKeys: string[] = [],
    options?: { lookupOnly?: boolean }
): Promise<string | undefined> {
    try {
        const storage = new GoogleCloudStorage();
        const bucket = storage.bucket(gcpBucket);

        let restoredKey: string | undefined = undefined;
        let fileToDownload: ReturnType<typeof bucket.file> | undefined =
            undefined;

        const keyCandidates = [primaryKey, ...restoreKeys];

        for (const candidateKey of keyCandidates) {
            if (!candidateKey) continue;

            const candidateZst = bucket.file(
                `${gcpPrefix}${candidateKey}.tar.zst`
            );
            const [zstExists] = await candidateZst.exists();
            if (zstExists) {
                restoredKey = candidateKey;
                fileToDownload = candidateZst;
                break;
            }

            const candidateGz = bucket.file(
                `${gcpPrefix}${candidateKey}.tar.gz`
            );
            const [gzExists] = await candidateGz.exists();
            if (gzExists) {
                restoredKey = candidateKey;
                fileToDownload = candidateGz;
                break;
            }

            const searchPrefix = `${gcpPrefix}${candidateKey}`;
            const [files] = await bucket.getFiles({ prefix: searchPrefix });
            const matchingFiles = files.filter(
                f => f.name.endsWith(".tar.zst") || f.name.endsWith(".tar.gz")
            );
            if (matchingFiles.length > 0) {
                matchingFiles.sort((a, b) => {
                    const timeA = a.metadata.updated
                        ? new Date(a.metadata.updated).getTime()
                        : 0;
                    const timeB = b.metadata.updated
                        ? new Date(b.metadata.updated).getTime()
                        : 0;
                    return timeB - timeA;
                });
                fileToDownload = bucket.file(matchingFiles[0].name);
                const nameWithoutPrefix =
                    gcpPrefix && matchingFiles[0].name.startsWith(gcpPrefix)
                        ? matchingFiles[0].name.slice(gcpPrefix.length)
                        : matchingFiles[0].name;
                restoredKey = nameWithoutPrefix.replace(/\.tar\.(zst|gz)$/, "");
                break;
            }
        }

        if (!restoredKey || !fileToDownload) {
            return undefined;
        }

        if (options?.lookupOnly) {
            return restoredKey;
        }

        core.info(
            `Downloading cache stream from GCS bucket gs://${gcpBucket}/${fileToDownload.name}`
        );

        const cwd =
            process.platform === "win32"
                ? process.env.SystemDrive
                    ? process.env.SystemDrive + "\\"
                    : "C:\\"
                : "/";

        const isZst = fileToDownload.name.endsWith(".tar.zst");
        const hasZstd = await isZstdAvailable();

        let tarArgs: string[];
        if (isZst && hasZstd) {
            tarArgs = ["-I", "zstd -d -T0", "-xf", "-"];
        } else if (isZst) {
            tarArgs = ["--use-compress-program=zstd", "-xf", "-"];
        } else {
            tarArgs = ["-zxf", "-"];
        }

        core.info(`Extracting cache archive from GCS to ${cwd}`);
        const tarProcess = child_process.spawn("tar", tarArgs, {
            cwd,
            stdio: ["pipe", "inherit", "inherit"]
        });

        const readStream = fileToDownload.createReadStream();

        await Promise.all([
            pipeline(readStream, tarProcess.stdin),
            new Promise<void>((resolve, reject) => {
                tarProcess.on("close", code => {
                    if (code === 0) resolve();
                    else
                        reject(
                            new Error(`tar process exited with code ${code}`)
                        );
                });
                tarProcess.on("error", err => reject(err));
            })
        ]);

        return restoredKey;
    } catch (error: unknown) {
        core.warning(
            `Failed to restore cache from GCS: ${(error as Error).message}`
        );
        return undefined;
    }
}

export async function saveGcsCache(
    gcpBucket: string,
    gcpPrefix: string = "",
    paths: string[],
    primaryKey: string
): Promise<number> {
    try {
        const cwd =
            process.platform === "win32"
                ? process.env.SystemDrive
                    ? process.env.SystemDrive + "\\"
                    : "C:\\"
                : "/";

        const excludePaths = paths
            .filter(p => p.startsWith("!"))
            .map(p => `--exclude=${path.relative(cwd, p.slice(1))}`);
        const includePaths = paths
            .filter(p => !p.startsWith("!"))
            .map(p => path.relative(cwd, p));

        if (includePaths.length === 0) {
            core.warning("No paths specified to cache.");
            return -1;
        }

        const hasZstd = await isZstdAvailable();
        const extension = hasZstd ? ".tar.zst" : ".tar.gz";

        let tarArgs: string[];
        if (hasZstd) {
            tarArgs = [
                "-I",
                "zstd -T0 -1",
                "-cf",
                "-",
                ...excludePaths,
                ...includePaths
            ];
        } else {
            tarArgs = ["-zcf", "-", ...excludePaths, ...includePaths];
        }

        const destFileName = `${gcpPrefix}${primaryKey}${extension}`;
        core.info(
            `Creating cache archive and uploading stream to GCS bucket gs://${gcpBucket}/${destFileName}`
        );

        const storage = new GoogleCloudStorage();
        const bucket = storage.bucket(gcpBucket);
        const writeStream = bucket.file(destFileName).createWriteStream({
            resumable: false
        });

        const tarProcess = child_process.spawn("tar", tarArgs, {
            cwd,
            stdio: ["ignore", "pipe", "inherit"]
        });

        await Promise.all([
            pipeline(tarProcess.stdout, writeStream),
            new Promise<void>((resolve, reject) => {
                tarProcess.on("close", code => {
                    if (code === 0) resolve();
                    else
                        reject(
                            new Error(`tar process exited with code ${code}`)
                        );
                });
                tarProcess.on("error", err => reject(err));
            })
        ]);

        core.info("Cache saved to Google Cloud Storage successfully");
        return 1;
    } catch (error: unknown) {
        core.warning(
            `Failed to save cache to GCS: ${(error as Error).message}`
        );
        return -1;
    }
}
