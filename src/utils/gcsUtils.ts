import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { Storage as GoogleCloudStorage } from "@google-cloud/storage";
import * as fs from "fs";
import * as path from "path";

export async function restoreGcsCache(
    gcpBucket: string,
    gcpPrefix: string = "",
    paths: string[],
    primaryKey: string,
    restoreKeys: string[] = [],
    options?: { lookupOnly?: boolean }
): Promise<string | undefined> {
    try {
        const tempDir =
            process.env["RUNNER_TEMP"] ||
            (process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp");
        const tarPath = path.join(
            tempDir,
            `cache_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.tar.gz`
        );

        const storage = new GoogleCloudStorage();
        const bucket = storage.bucket(gcpBucket);

        let restoredKey: string | undefined = undefined;
        let fileToDownload: ReturnType<typeof bucket.file> | undefined =
            undefined;

        // 1. Check exact primary key
        const exactFile = bucket.file(`${gcpPrefix}${primaryKey}.tar.gz`);
        const [exactExists] = await exactFile.exists();
        if (exactExists) {
            restoredKey = primaryKey;
            fileToDownload = exactFile;
        } else {
            // 2. Check restore keys
            for (const rKey of restoreKeys) {
                if (!rKey) continue;
                const rFile = bucket.file(`${gcpPrefix}${rKey}.tar.gz`);
                const [rExists] = await rFile.exists();
                if (rExists) {
                    restoredKey = rKey;
                    fileToDownload = rFile;
                    break;
                }

                // Prefix search in bucket
                const searchPrefix = `${gcpPrefix}${rKey}`;
                const [files] = await bucket.getFiles({ prefix: searchPrefix });
                const matchingFiles = files.filter(f =>
                    f.name.endsWith(".tar.gz")
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
                    const nameWithoutPrefix = gcpPrefix && matchingFiles[0].name.startsWith(gcpPrefix)
                        ? matchingFiles[0].name.slice(gcpPrefix.length)
                        : matchingFiles[0].name;
                    restoredKey = nameWithoutPrefix.replace(
                        /\.tar\.gz$/,
                        ""
                    );
                    break;
                }
            }
        }

        if (!restoredKey || !fileToDownload) {
            return undefined;
        }

        if (options?.lookupOnly) {
            return restoredKey;
        }

        core.info(
            `Downloading cache from GCS bucket gs://${gcpBucket}/${fileToDownload.name}`
        );
        await fileToDownload.download({ destination: tarPath });

        const cwd =
            process.platform === "win32"
                ? process.env.SystemDrive
                    ? process.env.SystemDrive + "\\"
                    : "C:\\"
                : "/";

        core.info(`Extracting cache archive from GCS to ${cwd}`);
        await exec.exec("tar", ["-zxf", tarPath], { cwd });

        try {
            if (fs.existsSync(tarPath)) {
                fs.unlinkSync(tarPath);
            }
        } catch {
            // ignore temp file deletion error
        }

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
        const tempDir =
            process.env["RUNNER_TEMP"] ||
            (process.platform === "win32" ? "C:\\Windows\\Temp" : "/tmp");
        const tarPath = path.join(
            tempDir,
            `cache_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.tar.gz`
        );

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

        core.info(`Creating cache archive for GCS key: ${primaryKey}`);
        await exec.exec(
            "tar",
            ["-zcf", tarPath, ...excludePaths, ...includePaths],
            { cwd }
        );

        const storage = new GoogleCloudStorage();
        const bucket = storage.bucket(gcpBucket);

        const destFileName = `${gcpPrefix}${primaryKey}.tar.gz`;
        core.info(
            `Uploading cache to GCS bucket gs://${gcpBucket}/${destFileName}`
        );
        await bucket.upload(tarPath, { destination: destFileName });

        try {
            if (fs.existsSync(tarPath)) {
                fs.unlinkSync(tarPath);
            }
        } catch {
            // ignore temp file deletion error
        }

        core.info("Cache saved to Google Cloud Storage successfully");
        return 1;
    } catch (error: unknown) {
        core.warning(
            `Failed to save cache to GCS: ${(error as Error).message}`
        );
        return -1;
    }
}
