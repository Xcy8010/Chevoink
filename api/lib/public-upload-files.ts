import { chmod, stat, writeFile } from 'node:fs/promises'

// Nginx serves public uploads under a different account from the API.
// Keep the process umask for private files and expose only the public media leaf.
export async function allowPublicUploadDirectory(directory: string): Promise<void> {
  await chmod(directory, (await stat(directory)).mode | 0o755)
}

export async function writePublicUploadFile(filename: string, buffer: Buffer): Promise<void> {
  await writeFile(filename, buffer)
  await chmod(filename, 0o644)
}
