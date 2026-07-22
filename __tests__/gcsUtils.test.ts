import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";

const mockExists = jest.fn<() => Promise<[boolean]>>();
const mockDownload = jest.fn<() => Promise<void>>();
const mockGetFiles = jest.fn<() => Promise<[any[]]>>();
const mockUpload = jest.fn<() => Promise<void>>();

const mockFile = jest.fn((name: string) => ({
    name,
    exists: mockExists,
    download: mockDownload,
    metadata: { updated: "2026-01-01T00:00:00Z" }
}));

const mockBucket = jest.fn((name: string) => ({
    name,
    file: mockFile,
    getFiles: mockGetFiles,
    upload: mockUpload
}));

jest.unstable_mockModule("@google-cloud/storage", () => ({
    Storage: jest.fn(() => ({
        bucket: mockBucket
    }))
}));

jest.unstable_mockModule("@actions/exec", () => ({
    exec: jest.fn<() => Promise<number>>().mockResolvedValue(0)
}));

jest.unstable_mockModule("@actions/core", () => ({
    getInput: jest.fn(() => ""),
    setOutput: jest.fn(),
    setFailed: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    debug: jest.fn()
}));

const exec = await import("@actions/exec");
const core = await import("@actions/core");
const { restoreGcsCache, saveGcsCache } = await import(
    "../src/utils/gcsUtils"
);

beforeEach(() => {
    jest.clearAllMocks();
});

test("restoreGcsCache returns primary key when exact match exists", async () => {
    mockExists.mockResolvedValue([true]);

    const result = await restoreGcsCache(
        "my-bucket",
        "my-prefix/",
        ["path/to/dir"],
        "my-key",
        ["restore-prefix-"]
    );

    expect(result).toBe("my-key");
    expect(mockBucket).toHaveBeenCalledWith("my-bucket");
    expect(mockFile).toHaveBeenCalledWith("my-prefix/my-key.tar.gz");
    expect(mockDownload).toHaveBeenCalled();
    expect(exec.exec).toHaveBeenCalledWith(
        "tar",
        ["-zxf", expect.any(String)],
        { cwd: expect.any(String) }
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
    expect(exec.exec).toHaveBeenCalledWith(
        "tar",
        ["-zxf", expect.any(String)],
        { cwd: expect.any(String) }
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

test("saveGcsCache archives paths and uploads to GCS bucket with prefix", async () => {
    mockUpload.mockResolvedValue();

    const result = await saveGcsCache(
        "my-bucket",
        "my-prefix/",
        ["path/to/dir", "!path/to/dir/ignore"],
        "my-key"
    );

    expect(result).toBe(1);
    expect(exec.exec).toHaveBeenCalledWith(
        "tar",
        [
            "-zcf",
            expect.any(String),
            expect.stringContaining("--exclude="),
            expect.any(String)
        ],
        { cwd: expect.any(String) }
    );
    expect(mockUpload).toHaveBeenCalledWith(
        expect.any(String),
        { destination: "my-prefix/my-key.tar.gz" }
    );
});
