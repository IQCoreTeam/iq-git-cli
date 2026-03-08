export const DEFAULT_CHUNK_SIZE = 850;

export const chunkString = (
    value: string,
    chunkSize: number = DEFAULT_CHUNK_SIZE,
) => {
    if (value.length === 0) {
        return [];
    }
    const chunks: string[] = [];
    let current = "";
    let currentBytes = 0;
    for (const char of value) {
        const charBytes = Buffer.byteLength(char, "utf8");
        if (charBytes > chunkSize) {
            if (current.length > 0) {
                chunks.push(current);
                current = "";
                currentBytes = 0;
            }
            chunks.push(char);
            continue;
        }
        if (currentBytes + charBytes > chunkSize && current.length > 0) {
            chunks.push(current);
            current = "";
            currentBytes = 0;
        }
        current += char;
        currentBytes += charBytes;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
};
///Changed the chunking by byte size 850, not string length
