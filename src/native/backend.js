"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const NATIVE_PROTOCOL_VERSION = 1;
const NATIVE_OP = Object.freeze({
  LIST: 1,
  READ: 2,
  WRITE: 3,
  DELETE: 4,
  RENAME: 5,
  TEST: 6,
  MKDIR: 8,
  REPLACE_FILE: 9,
  HEADER_STATUS: 10,
  SET_HEADER_ENCRYPTION: 12,
  ITEM_UPDATE_MODE: 14,
  READ_REBLOCK_ITEM: 15,
  WRITE_REBLOCK_ITEM: 16
});

const NATIVE_FLAG = Object.freeze({
  RECURSIVE: 1 << 0,
  DATA_ENCRYPTED: 1 << 1,
  HEADER_ENCRYPTED: 1 << 2
});


// Explicit plaintext-on-disk session used when full filesystem tooling is the
// goal. Unlike both virtual modes, plaintext persistence is intentional here.
// Keep that trade-off visible and never reuse this controller from a virtual
// mode as an implementation shortcut.

class Native7zBackend {
  constructor(bridgeExe, libraryPath) {
    this.bridgeExe = bridgeExe;
    this.libraryPath = libraryPath;
  }

  ensureAvailable() {
    if (!fs.existsSync(this.bridgeExe)) {
      throw new Error(
        `Native bridge was not found: ${this.bridgeExe}\n` +
        `Run native\\build-native.ps1 first.`
      );
    }
    if (!fs.existsSync(this.libraryPath)) {
      throw new Error(
        `Bundled 7z.dll was not found: ${this.libraryPath}\n` +
        `Run native\\build-native.ps1 first.`
      );
    }
  }

  async list(archivePath, password) {
    const response = await this.request(NATIVE_OP.LIST, {
      archivePath,
      password
    });
    return response.items.map((item) => ({
      path: item.path,
      isDirectory: (item.flags & 1) !== 0,
      encrypted: (item.flags & 2) !== 0,
      size: item.size
    }));
  }

  async read(archivePath, password, innerPath) {
    const response = await this.request(NATIVE_OP.READ, {
      archivePath,
      password,
      path1: innerPath
    });

    const result = new Uint8Array(response.data);
    response.data.fill(0);
    return result;
  }

  async write(
    archivePath,
    password,
    innerPath,
    input,
    dataEncrypted
  ) {
    await this.request(NATIVE_OP.WRITE, {
      archivePath,
      password,
      path1: innerPath,
      data: Buffer.from(input),
      flags: dataEncrypted ? NATIVE_FLAG.DATA_ENCRYPTED : 0
    });
  }

  async mkdir(archivePath, password, innerPath) {
    await this.request(NATIVE_OP.MKDIR, {
      archivePath,
      password,
      path1: innerPath
    });
  }

  async delete(archivePath, password, innerPath, recursive) {
    await this.request(NATIVE_OP.DELETE, {
      archivePath,
      password,
      path1: innerPath,
      flags: recursive ? NATIVE_FLAG.RECURSIVE : 0
    });
  }

  async rename(archivePath, password, oldPath, newPath) {
    await this.request(NATIVE_OP.RENAME, {
      archivePath,
      password,
      path1: oldPath,
      path2: newPath
    });
  }

  async test(archivePath, password) {
    await this.request(NATIVE_OP.TEST, {
      archivePath,
      password
    });
  }

  async replaceFile(originalPath, replacementPath, backupPath) {
    await this.request(NATIVE_OP.REPLACE_FILE, {
      archivePath: originalPath,
      path1: replacementPath,
      path2: backupPath
    });
  }

  async getHeaderEncryption(archivePath, password) {
    const response = await this.request(NATIVE_OP.HEADER_STATUS, {
      archivePath,
      password
    });

    if (response.message !== "0" && response.message !== "1") {
      throw new Error(
        `Native backend returned invalid header-encryption status: ${response.message}`
      );
    }
    return response.message === "1";
  }


  async setHeaderEncryption(
    archivePath,
    password,
    encrypted
  ) {
    await this.request(NATIVE_OP.SET_HEADER_ENCRYPTION, {
      archivePath,
      password,
      flags: encrypted ? NATIVE_FLAG.HEADER_ENCRYPTED : 0
    });
  }

  async readReblockItem(
    archivePath,
    password,
    innerPath
  ) {
    const response = await this.request(NATIVE_OP.READ_REBLOCK_ITEM, {
      archivePath,
      password,
      path1: innerPath
    });

    const result = new Uint8Array(response.data);
    response.data.fill(0);
    return result;
  }

  async writeReblockItem(
    archivePath,
    password,
    innerPath,
    state,
    dataEncrypted
  ) {
    await this.request(NATIVE_OP.WRITE_REBLOCK_ITEM, {
      archivePath,
      password,
      path1: innerPath,
      data: state,
      flags: dataEncrypted ? NATIVE_FLAG.DATA_ENCRYPTED : 0
    });
  }

  async getItemUpdateMode(
    archivePath,
    password,
    innerPath
  ) {
    const response = await this.request(NATIVE_OP.ITEM_UPDATE_MODE, {
      archivePath,
      password,
      path1: innerPath
    });

    if (
      response.message !== "direct" &&
      response.message !== "reblock"
    ) {
      throw new Error(
        `Native backend returned invalid item update mode: ${response.message}`
      );
    }

    return response.message;
  }

  request(op, {
    archivePath = "",
    password = "",
    path1 = "",
    path2 = "",
    data = Buffer.alloc(0),
    flags = 0
  }) {
    this.ensureAvailable();

    const libraryBytes = Buffer.from(this.libraryPath, "utf8");
    const archiveBytes = Buffer.from(archivePath, "utf8");
    const passwordBytes = Buffer.from(password, "utf8");
    const path1Bytes = Buffer.from(path1, "utf8");
    const path2Bytes = Buffer.from(path2, "utf8");
    const dataBytes = Buffer.from(data);

    const header = Buffer.alloc(44);
    header.write("E7Q1", 0, 4, "ascii");
    header.writeUInt32LE(NATIVE_PROTOCOL_VERSION, 4);
    header.writeUInt32LE(op, 8);
    header.writeUInt32LE(flags >>> 0, 12);
    header.writeUInt32LE(libraryBytes.length, 16);
    header.writeUInt32LE(archiveBytes.length, 20);
    header.writeUInt32LE(passwordBytes.length, 24);
    header.writeUInt32LE(path1Bytes.length, 28);
    header.writeUInt32LE(path2Bytes.length, 32);
    header.writeBigUInt64LE(BigInt(dataBytes.length), 36);

    const request = Buffer.concat([
      header,
      libraryBytes,
      archiveBytes,
      passwordBytes,
      path1Bytes,
      path2Bytes,
      dataBytes
    ]);

    // The password never appears in argv or environment variables.
    const child = spawn(this.bridgeExe, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    return new Promise((resolve, reject) => {
      const stdout = [];
      const stderr = [];
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        passwordBytes.fill(0);
        dataBytes.fill(0);
        request.fill(0);
        reject(error);
      };

      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", fail);

      child.on("close", (code) => {
        if (settled) return;
        settled = true;

        passwordBytes.fill(0);
        dataBytes.fill(0);
        request.fill(0);

        const stderrBuffer = Buffer.concat(stderr);
        const stderrText = stderrBuffer.toString("utf8").trim();
        stderrBuffer.fill(0);
        if (code !== 0) {
          reject(
            new Error(
              stderrText ||
              `Native 7z bridge exited unexpectedly with code ${code}.`
            )
          );
          return;
        }

        let rawResponse;
        try {
          rawResponse = Buffer.concat(stdout);
          const response = parseNativeResponse(rawResponse);
          if (response.status !== 0) {
            response.data.fill(0);

            let nativeMessage =
              response.message || "Native 7z operation failed.";

            // With BIT7Z_USE_NATIVE_STRING on Japanese Windows, the OS text
            // appended to std::system_error::what() can arrive in a local
            // code page even though this bridge protocol is UTF-8. Keep the
            // useful bit7z category while avoiding mojibake in VS Code.
            if (nativeMessage.startsWith("Unsupported operation")) {
              nativeMessage =
                "Unsupported operation reported by 7-Zip/bit7z.";
            }

            reject(new Error(nativeMessage));
            return;
          }
          resolve(response);
        } catch (error) {
          reject(error);
        } finally {
          if (rawResponse) rawResponse.fill(0);
          for (const chunk of stdout) chunk.fill(0);
          for (const chunk of stderr) chunk.fill(0);
        }
      });

      child.stdin.on("error", fail);
      child.stdin.end(request);
    });
  }
}

function parseNativeResponse(buffer) {
  if (buffer.length < 28) {
    throw new Error("Native bridge returned a truncated response.");
  }
  if (buffer.toString("ascii", 0, 4) !== "E7R1") {
    throw new Error("Native bridge returned an invalid response.");
  }

  const version = buffer.readUInt32LE(4);
  if (version !== NATIVE_PROTOCOL_VERSION) {
    throw new Error(`Unsupported native bridge protocol version: ${version}`);
  }

  const status = buffer.readInt32LE(8);
  const messageLength = buffer.readUInt32LE(12);
  const itemCount = buffer.readUInt32LE(16);
  const dataLengthBig = buffer.readBigUInt64LE(20);

  if (dataLengthBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Native bridge response is too large.");
  }

  let offset = 28;
  const need = (length) => {
    if (length > buffer.length - offset) {
      throw new Error("Native bridge response is truncated.");
    }
  };

  need(messageLength);
  const message = buffer.toString(
    "utf8",
    offset,
    offset + messageLength
  );
  offset += messageLength;

  const items = [];
  for (let i = 0; i < itemCount; i++) {
    need(16);
    const pathLength = buffer.readUInt32LE(offset);
    const flags = buffer.readUInt32LE(offset + 4);
    const sizeBig = buffer.readBigUInt64LE(offset + 8);
    offset += 16;

    need(pathLength);
    const itemPath = buffer.toString("utf8", offset, offset + pathLength);
    offset += pathLength;

    items.push({
      path: itemPath,
      flags,
      size: sizeBig <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(sizeBig)
        : Number.MAX_SAFE_INTEGER
    });
  }

  const dataLength = Number(dataLengthBig);
  need(dataLength);
  const data = Buffer.from(buffer.subarray(offset, offset + dataLength));
  offset += dataLength;

  if (offset !== buffer.length) {
    throw new Error("Native bridge response has unexpected trailing bytes.");
  }

  return { status, message, items, data };
}

function getNativeBackend(context) {
  if (process.platform !== "win32") {
    throw new Error(
      "Secure Mode native backend currently supports Windows only."
    );
  }
  if (process.arch !== "x64") {
    throw new Error(
      `Secure Mode currently includes only win32-x64 build support (current: ${process.arch}).`
    );
  }

  // SECURITY: the helper receives the password over stdin. Never let an
  // opened workspace redirect this path to an arbitrary executable.
  const binDir = path.join(
    context.extensionPath,
    "native",
    "bin",
    "win32-x64"
  );

  return new Native7zBackend(
    path.join(binDir, "e7z_bridge.exe"),
    path.join(binDir, "7z.dll")
  );
}


module.exports = {
  NATIVE_PROTOCOL_VERSION,
  NATIVE_OP,
  NATIVE_FLAG,
  Native7zBackend,
  parseNativeResponse,
  getNativeBackend
};
