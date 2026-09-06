# Native Bridge Protocol

The helper is a one-request/one-process binary protocol over stdin/stdout.

No password is passed in argv or environment variables.

## Request

Little-endian:

```text
4 bytes   magic = E7Q1
u32       version = 1
u32       op
u32       flags
u32       7z.dll UTF-8 byte length
u32       archive path UTF-8 byte length
u32       password UTF-8 byte length
u32       path1 UTF-8 byte length
u32       path2 UTF-8 byte length
u64       binary data length
bytes     7z.dll path
bytes     archive path
bytes     password
bytes     path1
bytes     path2
bytes     data
```

Operations:

```text
1  LIST
2  READ
3  WRITE (add or replace)
4  DELETE
5  RENAME
6  TEST
8  MKDIR
9  REPLACE_FILE
10 HEADER_STATUS
12 SET_HEADER_ENCRYPTION
14 ITEM_UPDATE_MODE
15 READ_REBLOCK_ITEM
16 WRITE_REBLOCK_ITEM
```

Flags:

```text
bit 0  recursive DELETE
bit 1  encrypted file data for WRITE
bit 2  encrypted headers for SET_HEADER_ENCRYPTION
```

Operation ids 7, 11 and 13 are currently unused. Renumbering is intentionally
deferred until protocol cleanup is treated as its own reviewed change.

## Response

```text
4 bytes   magic = E7R1
u32       version = 1
i32       status (0 = success)
u32       UTF-8 message byte length
u32       list item count
u64       binary data length
bytes     message

repeated list item:
  u32     path UTF-8 byte length
  u32     flags (bit0 directory, bit1 encrypted)
  u64     uncompressed size
  bytes   path

bytes     binary data
```

For READ, `data` is the decrypted file bytes.

The helper exits after every operation. It best-effort zeroes the password,
request data and response data before process termination.


## MKDIR implementation

`MKDIR` creates a real 7z directory item. The helper briefly creates a
cryptographically random-named empty directory in the Windows TEMP directory
and passes it to `BitArchiveEditor::addItems()` with the requested archive path
as an alias.

No file content is written to TEMP, and the requested archive directory name is
not used as a filesystem name. The random empty directory is removed by RAII
cleanup after the archive update.


## Design intent

The binary protocol is private to this extension.

Security and lifecycle requirements:

- do not put the password in argv
- do not put the password in environment variables
- one request should correspond to one short-lived helper process
- best-effort zero password/request/response buffers before process exit
- keep the helper executable and `7z.dll` paths fixed under the extension
  installation directory
- do not accept a workspace setting that redirects the helper

## Solid reblock item state

`READ_REBLOCK_ITEM` and `WRITE_REBLOCK_ITEM` are used only by the Data
Encryption toggle fallback for a non-empty follower in a solid block. The
fallback must detach the item (`DELETE`) and add it again as new data; these
operations keep the existing one-request/one-process phase separation.

`READ_REBLOCK_ITEM` returns an opaque binary state in the normal response
`data` field. JavaScript does not interpret the state. It keeps the bytes in
memory, passes them to `WRITE_REBLOCK_ITEM` after the separate `DELETE` phase,
and best-effort zeroes the buffer afterwards.

The state contains the decrypted file bytes plus the original archive item
properties needed to avoid turning a re-added item into a newly timestamped
`FILE_ATTRIBUTE_NORMAL` item:

- Win32 `Attrib`, when present
- `MTime`, when present

The embedded archive-member path is checked again by the native writer before
the state is accepted. No plaintext file is materialized on disk.

This pair is deliberately narrow. Normal `READ`/`WRITE`, direct item updates,
Materialized reconciliation, header-encryption phases, and the protocol
version are unchanged.

