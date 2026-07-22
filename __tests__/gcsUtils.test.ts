import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { Readable, Writable } from "stream";

const mockExists = jest.fn<() => Promise<[boolean]>>();
const mockGetFiles = jest.fn<() => Promise<[any[]]>>();

const mockFile = jest.fn((name: string) => ({
    name,
    exists: mockExists,
    createReadStream: jest.fn(() => Readable.from(["mock tar data"])),
    createWriteStream: jest.fn(
        () =>
            new Writable({
                write(_chunk, _encoding, callback) {
                    callback();
                }
            })
    ),
    metadata: { updated: "2026-01-01T00:00:00Z" }
}));

const mockBucket = jest.fn((name: string) => ({
    name,
    file: mockFile,
    getFiles: mockGetFiles
}));

jest.unstable_mockModule("@google-cloud/storage", () => ({
    Storage: jest.fn(() => ({
        bucket: mockBucket
    }))
}));

const createMockProcess = () => ({
    stdin: new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        }
    }),
    stdout: Readable.from(["mock stdout tar data"]),
    on: jest.fn((event: string, cb: (code?: number) => void) => {
        if (event === "close") {
            process.nextTick(() => cb(0));
        }
    })
});

const spawnMock = jest.fn(() => createMockProcess());

jest.unstable_mockModule("child_process", () => ({
    spawn: spawnMock
}));

const whichMock = jest.fn<() => Promise<string>>().mockResolvedValue("");

jest.unstable_mockModule("@actions/io", () => ({
    which: whichMock
}));

jest.unstable_mockModule("@actions/core", () => ({
    getInput: jest.fn(() => ""),
    setOutput: jest.fn(),
    setFailed: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    debug: jest.fn()
}));

const child_process = await import("child_process");
const io = await import("@actions/io");
const core = await import("@actions/core");
const { restoreGcsCache, saveGcsCache } = await import(
    "../src/utils/gcsUtils"
);

beforeEach(() => {
    jest.clearAllMocks();
    whichMock.mockResolvedValue("");
    spawnMock.mockImplementation(() => createMockProcess() as any);
});

test("restoreGcsCache returns primary key when exact match exists", async () => {
    mockExists.mockImplementation(async function (this: any) {
        return [this.name.endsWith(".tar.gz")];
    });

    const result = await restoreGcsCache(
        "my-bucket",
        "my-prefix/",
        ["path/to/dir"],
        "my-key",
        ["restore-prefix-"]
    );

    expect(result).toBe("my-key");
    expect(mockBucket).toHaveBeenCalledWith("my-bucket");
    expect(spawnMock).toHaveBeenCalledWith(
        "tar",
        ["-zxf", "-"],
        { cwd: expect.any(String), stdio: ["pipe", "inherit", "inherit"] }
    );
});

test("restoreGcsCache uses zstd when zstd archive exists and zstd is available", async () => {
    whichMock.mockResolvedValue("/usr/bin/zstd");
    mockExists.mockImplementation(async function (this: any) {
        return [true];
    });

    const result = await restoreGcsCache(
        "my-bucket",
        "my-prefix/",
        ["path/to/dir"],
        "my-key",
        ["restore-prefix-"]
    );

    expect(result).toBe("my-key");
    expect(spawnMock).toHaveBeenCalledWith(
        "tar",
        ["-I", "zstd -d -T0", "-xf", "-"],
        { cwd: expect.any(String), stdio: ["pipe", "inherit", "inherit"] }
    );
});

test("restoreGcsCache falls back to restore keys when primary key does not exist", async () => {
    mockExists.mockImplementation(async () => [false]);
    mockGetFiles.mockResolvedValue([
        [
            {
                name: "my-prefix/restore-prefix-123.tar.gz",
                metadata: { updated: "2026-01-02T00:00:00Z" }
            }
        ]
    ]);

    const result = await restoreGcsCache(
        "my-bucket",
        "my-prefix/",
        ["path/to/dir"],
        "my-key",
        ["restore-prefix-"]
    );

    expect(result).toBe("restore-prefix-123");
    expect(spawnMock).toHaveBeenCalledWith(
        "tar",
        ["-zxf", "-"],
        { cwd: expect.any(String), stdio: ["pipe", "inherit", "inherit"] }
    );
});

test("restoreGcsCache returns undefined when no match found", async () => {
    mockExists.mockResolvedValue([false]);
    mockGetFiles.mockResolvedValue([[]]);

    const result = await restoreGcsCache(
        "my-bucket",
        "my-prefix/",
        ["path/to/dir"],
        "my-key",
        ["restore-prefix-"]
    );

    expect(result).toBeUndefined();
});

test("saveGcsCache archives paths and streams to GCS bucket with prefix", async () => {
    const result = await saveGcsCache(
        "my-bucket",
        "my-prefix/",
        ["path/to/dir", "!path/to/dir/ignore"],
        "my-key"
    );

    expect(result).toBe(1);
    expect(spawnMock).toHaveBeenCalledWith(
        "tar",
        [
            "-zcf",
            "-",
            expect.stringContaining("--exclude="),
            expect.any(String)
        ],
        { cwd: expect.any(String), stdio: ["ignore", "pipe", "inherit"] }
    );
});

test("saveGcsCache uses zstd when available", async () => {
    whichMock.mockResolvedValue("/usr/bin/zstd");

    const result = await saveGcsCache(
        "my-bucket",
        "my-prefix/",
        ["path/to/dir"],
        "my-key"
    );

    expect(result).toBe(1);
    expect(spawnMock).toHaveBeenCalledWith(
        "tar",
        [
            "-I",
            "zstd -T0 -1",
            "-cf",
            "-",
            expect.any(String)
        ],
        { cwd: expect.any(String), stdio: ["ignore", "pipe", "inherit"] }
    );
});
