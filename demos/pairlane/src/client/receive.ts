/** A received file is never opened as the sender's MIME type. */
export const RECEIVED_FILE_TYPE = "application/octet-stream";

export function receivedFile(bytes: Uint8Array<ArrayBuffer>): Blob {
  return new Blob([bytes], { type: RECEIVED_FILE_TYPE });
}
