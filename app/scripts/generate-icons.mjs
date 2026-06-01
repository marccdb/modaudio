import { mkdir, copyFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import sharp from 'sharp'

const rootDir = process.cwd()
const buildDir = path.join(rootDir, 'build')
const iconDir = path.join(buildDir, 'icons')
const iconSetDir = path.join(iconDir, 'iconset')
const sourceSvg = path.join(buildDir, 'brand-mark.svg')
const appBuilderExe = path.join(rootDir, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe')
const sizes = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256, 512, 1024]

function runAppBuilder(format) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      appBuilderExe,
      ['icon', '--input', 'build/icons/iconset', '--format', format, '--out', 'build/icons', '--root', rootDir],
      { stdio: 'inherit' },
    )
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`app-builder icon (${format}) failed with code ${code}`))
    })
  })
}

await mkdir(iconSetDir, { recursive: true })

await sharp(sourceSvg).resize(1024, 1024).png().toFile(path.join(iconDir, 'icon-1024.png'))
for (const size of sizes) {
  await sharp(sourceSvg).resize(size, size).png().toFile(path.join(iconSetDir, `${size}x${size}.png`))
}

await runAppBuilder('ico')
await runAppBuilder('icns')
await copyFile(path.join(iconDir, 'icon-1024.png'), path.join(iconDir, 'icon.png'))
