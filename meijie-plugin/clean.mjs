#!/usr/bin/env node

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const scanRoot = path.resolve(currentDirectory, '..')
const targetDirectoryName = 'node_modules'
const skippedDirectoryNames = new Set([
  '.git',
  '.idea',
  '.next',
  '.nuxt',
  '.vscode',
  'build',
  'dist',
])

const stats = {
  deleted: 0,
  errors: 0,
}

/**
 * Recursively deletes dependency directories below a directory.
 *
 * @param {string} directory Directory to scan.
 * @returns {Promise<void>} Resolves after all accessible descendants are scanned.
 */
async function deleteDependencyDirectories(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    const subdirectories = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const entryPath = path.join(directory, entry.name)
      if (entry.name === targetDirectoryName) {
        console.log(`🗑️  删除: ${entryPath}`)
        try {
          await fs.rm(entryPath, { recursive: true, force: true })
          stats.deleted += 1
          console.log(`✅ 已删除: ${entryPath}`)
        } catch (error) {
          stats.errors += 1
          console.error(`❌ 删除失败: ${entryPath}`, error)
        }
        continue
      }

      if (!skippedDirectoryNames.has(entry.name)) subdirectories.push(entryPath)
    }

    await Promise.all(subdirectories.map(deleteDependencyDirectories))
  } catch (error) {
    stats.errors += 1
    console.warn(`⚠️  无法访问目录: ${directory}`, error)
  }
}

/**
 * Scans the parent directory and reports cleanup results.
 *
 * @returns {Promise<void>} Resolves after cleanup completes.
 */
async function main() {
  console.log(`🔍 开始扫描目录: ${scanRoot}`)
  console.log(`📦 目标文件夹: ${targetDirectoryName}`)
  console.log('─'.repeat(50))

  const startTime = Date.now()

  try {
    await fs.access(scanRoot)
    await deleteDependencyDirectories(scanRoot)

    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log('─'.repeat(50))
    console.log('📊 执行完成！统计信息：')
    console.log(`   ✅ 成功删除: ${stats.deleted} 个文件夹`)
    console.log(`   ⚠️  错误: ${stats.errors} 个`)
    console.log(`   ⏱️  耗时: ${elapsedSeconds} 秒`)
    console.log('─'.repeat(50))

    if (stats.deleted > 0) {
      console.log('🎉 清理完成！')
    } else {
      console.log('ℹ️  没有找到需要删除的 node_modules 文件夹')
    }
  } catch (error) {
    console.error('❌ 程序执行失败:', error)
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error('❌ 未捕获的错误:', error)
  process.exitCode = 1
})
