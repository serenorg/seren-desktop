// ABOUTME: Code chunking service for semantic indexing.
// ABOUTME: Splits source files into meaningful chunks at function/class boundaries.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// Maximum lines per chunk (prevents overly large chunks)
const MAX_CHUNK_LINES: usize = 100;

/// Minimum lines per chunk (prevents tiny chunks)
const MIN_CHUNK_LINES: usize = 5;

/// A code chunk extracted from a source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub start_line: i32,
    pub end_line: i32,
    pub content: String,
    pub chunk_type: ChunkType,
    pub symbol_name: Option<String>,
}

/// Type of code chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChunkType {
    Function,
    Class,
    Module,
    Block,
    File,
}

impl std::fmt::Display for ChunkType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChunkType::Function => write!(f, "function"),
            ChunkType::Class => write!(f, "class"),
            ChunkType::Module => write!(f, "module"),
            ChunkType::Block => write!(f, "block"),
            ChunkType::File => write!(f, "file"),
        }
    }
}

/// Detect language from file extension.
pub fn detect_language(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?;
    let lang = match ext.to_lowercase().as_str() {
        "rs" => "rust",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" => "javascript",
        "py" => "python",
        "go" => "go",
        "java" => "java",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" => "cpp",
        "cs" => "csharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" | "kts" => "kotlin",
        "scala" => "scala",
        "r" => "r",
        "sql" => "sql",
        "sh" | "bash" | "zsh" => "shell",
        "ps1" => "powershell",
        "yml" | "yaml" => "yaml",
        "json" => "json",
        "toml" => "toml",
        "xml" => "xml",
        "html" | "htm" => "html",
        "css" | "scss" | "sass" | "less" => "css",
        "md" | "markdown" => "markdown",
        "vue" => "vue",
        "svelte" => "svelte",
        _ => return None,
    };
    Some(lang.to_string())
}

/// Check if a file should be indexed based on extension.
pub fn is_indexable_file(path: &Path) -> bool {
    detect_language(path).is_some()
}

/// Chunk a source file into semantic units.
/// Falls back to simple line-based chunking if language-specific parsing fails.
pub fn chunk_file(content: &str, language: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return vec![];
    }

    // Try language-specific chunking first
    let chunks = match language {
        "rust" => chunk_rust(&lines),
        "typescript" | "javascript" => chunk_js_ts(&lines),
        "python" => chunk_python(&lines),
        _ => chunk_generic(&lines),
    };

    // If language-specific chunking produced no results, fall back to generic
    if chunks.is_empty() {
        return chunk_generic(&lines);
    }

    chunks
}

/// Chunk Rust source files by fn/impl/struct/enum/mod blocks.
fn chunk_rust(lines: &[&str]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current_start: Option<usize> = None;
    let mut brace_depth = 0;
    let mut current_type = ChunkType::Block;
    let mut current_name: Option<String> = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        // Detect start of a new block
        if current_start.is_none() {
            if let Some((chunk_type, name)) = detect_rust_block_start(trimmed) {
                current_start = Some(i);
                current_type = chunk_type;
                current_name = name;
                brace_depth = 0;
            }
        }

        // Track brace depth
        if current_start.is_some() {
            brace_depth += line.chars().filter(|c| *c == '{').count() as i32;
            brace_depth -= line.chars().filter(|c| *c == '}').count() as i32;

            // Block complete when braces balance
            if brace_depth <= 0 && line.contains('}') {
                let start = current_start.unwrap();
                let content = lines[start..=i].join("\n");

                // Only create chunk if it meets minimum size
                if i - start + 1 >= MIN_CHUNK_LINES {
                    chunks.push(Chunk {
                        start_line: (start + 1) as i32,
                        end_line: (i + 1) as i32,
                        content,
                        chunk_type: current_type.clone(),
                        symbol_name: current_name.clone(),
                    });
                }

                current_start = None;
                current_name = None;
            }
        }
    }

    chunks
}

fn detect_rust_block_start(line: &str) -> Option<(ChunkType, Option<String>)> {
    let trimmed = line.trim();

    // Skip comments and attributes
    if trimmed.starts_with("//") || trimmed.starts_with("#[") {
        return None;
    }

    // Function
    if trimmed.starts_with("pub fn ")
        || trimmed.starts_with("fn ")
        || trimmed.starts_with("pub async fn ")
        || trimmed.starts_with("async fn ")
    {
        let name = extract_identifier_after(trimmed, "fn ");
        return Some((ChunkType::Function, name));
    }

    // Impl block
    if trimmed.starts_with("impl ") || trimmed.starts_with("impl<") {
        let name = extract_impl_name(trimmed);
        return Some((ChunkType::Class, name));
    }

    // Struct
    if trimmed.starts_with("pub struct ") || trimmed.starts_with("struct ") {
        let name = extract_identifier_after(trimmed, "struct ");
        return Some((ChunkType::Class, name));
    }

    // Enum
    if trimmed.starts_with("pub enum ") || trimmed.starts_with("enum ") {
        let name = extract_identifier_after(trimmed, "enum ");
        return Some((ChunkType::Class, name));
    }

    // Module
    if trimmed.starts_with("pub mod ") || trimmed.starts_with("mod ") {
        let name = extract_identifier_after(trimmed, "mod ");
        return Some((ChunkType::Module, name));
    }

    None
}

fn extract_identifier_after(line: &str, keyword: &str) -> Option<String> {
    let after = line.split(keyword).nth(1)?;
    let ident: String = after
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if ident.is_empty() {
        None
    } else {
        Some(ident)
    }
}

fn extract_impl_name(line: &str) -> Option<String> {
    // Handle "impl Foo" and "impl Trait for Foo"
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() >= 2 {
        // Check for "for" keyword
        if let Some(pos) = parts.iter().position(|&s| s == "for") {
            if pos + 1 < parts.len() {
                return Some(parts[pos + 1].trim_matches(|c| c == '<' || c == '{').to_string());
            }
        }
        // Just "impl Type"
        Some(parts[1].trim_matches(|c| c == '<' || c == '{').to_string())
    } else {
        None
    }
}

/// Chunk JavaScript/TypeScript files by function/class/const declarations.
fn chunk_js_ts(lines: &[&str]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current_start: Option<usize> = None;
    let mut brace_depth = 0;
    let mut current_type = ChunkType::Block;
    let mut current_name: Option<String> = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        if current_start.is_none() {
            if let Some((chunk_type, name)) = detect_js_block_start(trimmed) {
                current_start = Some(i);
                current_type = chunk_type;
                current_name = name;
                brace_depth = 0;
            }
        }

        if current_start.is_some() {
            brace_depth += line.chars().filter(|c| *c == '{').count() as i32;
            brace_depth -= line.chars().filter(|c| *c == '}').count() as i32;

            if brace_depth <= 0 && (line.contains('}') || line.contains(';')) {
                let start = current_start.unwrap();
                let content = lines[start..=i].join("\n");

                if i - start + 1 >= MIN_CHUNK_LINES {
                    chunks.push(Chunk {
                        start_line: (start + 1) as i32,
                        end_line: (i + 1) as i32,
                        content,
                        chunk_type: current_type.clone(),
                        symbol_name: current_name.clone(),
                    });
                }

                current_start = None;
                current_name = None;
            }
        }
    }

    chunks
}

fn detect_js_block_start(line: &str) -> Option<(ChunkType, Option<String>)> {
    let trimmed = line.trim();

    // Skip comments
    if trimmed.starts_with("//") || trimmed.starts_with("/*") || trimmed.starts_with("*") {
        return None;
    }

    // Function declarations
    if trimmed.starts_with("function ")
        || trimmed.starts_with("async function ")
        || trimmed.starts_with("export function ")
        || trimmed.starts_with("export async function ")
    {
        let name = extract_js_function_name(trimmed);
        return Some((ChunkType::Function, name));
    }

    // Arrow functions with const/let
    if (trimmed.starts_with("const ") || trimmed.starts_with("export const "))
        && (trimmed.contains(" = (") || trimmed.contains(" = async ("))
    {
        let name = extract_const_name(trimmed);
        return Some((ChunkType::Function, name));
    }

    // Class
    if trimmed.starts_with("class ")
        || trimmed.starts_with("export class ")
        || trimmed.starts_with("export default class ")
    {
        let name = extract_identifier_after(trimmed, "class ");
        return Some((ChunkType::Class, name));
    }

    // Interface (TypeScript)
    if trimmed.starts_with("interface ") || trimmed.starts_with("export interface ") {
        let name = extract_identifier_after(trimmed, "interface ");
        return Some((ChunkType::Class, name));
    }

    // Type alias (TypeScript)
    if trimmed.starts_with("type ") || trimmed.starts_with("export type ") {
        let name = extract_identifier_after(trimmed, "type ");
        return Some((ChunkType::Class, name));
    }

    None
}

fn extract_js_function_name(line: &str) -> Option<String> {
    let after_fn = line.split("function ").nth(1)?;
    let name: String = after_fn
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn extract_const_name(line: &str) -> Option<String> {
    let after_const = line.split("const ").nth(1)?;
    let name: String = after_const
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Chunk Python files by def/class blocks using indentation.
fn chunk_python(lines: &[&str]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut current_start: Option<usize> = None;
    let mut current_indent = 0;
    let mut current_type = ChunkType::Block;
    let mut current_name: Option<String> = None;

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();

        // Calculate indentation level
        let indent = line.len() - line.trim_start().len();

        if current_start.is_none() {
            if let Some((chunk_type, name)) = detect_python_block_start(trimmed) {
                current_start = Some(i);
                current_indent = indent;
                current_type = chunk_type;
                current_name = name;
            }
        } else {
            // Block ends when we see a line at same or lower indentation (that's not blank)
            if !trimmed.is_empty() && indent <= current_indent && i > current_start.unwrap() {
                let start = current_start.unwrap();
                let content = lines[start..i].join("\n");

                if i - start >= MIN_CHUNK_LINES {
                    chunks.push(Chunk {
                        start_line: (start + 1) as i32,
                        end_line: i as i32,
                        content,
                        chunk_type: current_type.clone(),
                        symbol_name: current_name.clone(),
                    });
                }

                current_start = None;
                current_name = None;

                // Check if this line starts a new block
                if let Some((chunk_type, name)) = detect_python_block_start(trimmed) {
                    current_start = Some(i);
                    current_indent = indent;
                    current_type = chunk_type;
                    current_name = name;
                }
            }
        }
    }

    // Don't forget the last block
    if let Some(start) = current_start {
        let content = lines[start..].join("\n");
        if lines.len() - start >= MIN_CHUNK_LINES {
            chunks.push(Chunk {
                start_line: (start + 1) as i32,
                end_line: lines.len() as i32,
                content,
                chunk_type: current_type,
                symbol_name: current_name,
            });
        }
    }

    chunks
}

fn detect_python_block_start(line: &str) -> Option<(ChunkType, Option<String>)> {
    let trimmed = line.trim();

    // Skip comments and docstrings
    if trimmed.starts_with('#') || trimmed.starts_with("\"\"\"") || trimmed.starts_with("'''") {
        return None;
    }

    // Function
    if trimmed.starts_with("def ") || trimmed.starts_with("async def ") {
        let name = extract_python_name(trimmed, "def ");
        return Some((ChunkType::Function, name));
    }

    // Class
    if trimmed.starts_with("class ") {
        let name = extract_python_name(trimmed, "class ");
        return Some((ChunkType::Class, name));
    }

    None
}

fn extract_python_name(line: &str, keyword: &str) -> Option<String> {
    let after = line.split(keyword).nth(1)?;
    let name: String = after
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Generic chunking - splits file into fixed-size chunks.
fn chunk_generic(lines: &[&str]) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let total_lines = lines.len();

    // If file is small enough, make it one chunk
    if total_lines <= MAX_CHUNK_LINES {
        if total_lines >= MIN_CHUNK_LINES {
            chunks.push(Chunk {
                start_line: 1,
                end_line: total_lines as i32,
                content: lines.join("\n"),
                chunk_type: ChunkType::File,
                symbol_name: None,
            });
        }
        return chunks;
    }

    // Split into MAX_CHUNK_LINES sized chunks
    let mut start = 0;
    while start < total_lines {
        let end = (start + MAX_CHUNK_LINES).min(total_lines);
        let content = lines[start..end].join("\n");

        chunks.push(Chunk {
            start_line: (start + 1) as i32,
            end_line: end as i32,
            content,
            chunk_type: ChunkType::Block,
            symbol_name: None,
        });

        start = end;
    }

    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_language() {
        assert_eq!(detect_language(Path::new("foo.rs")), Some("rust".to_string()));
        assert_eq!(detect_language(Path::new("bar.ts")), Some("typescript".to_string()));
        assert_eq!(detect_language(Path::new("baz.py")), Some("python".to_string()));
        assert_eq!(detect_language(Path::new("unknown.xyz")), None);
    }

    #[test]
    fn test_chunk_rust() {
        let code = r#"
fn main() {
    println!("Hello");
    let x = 1;
    let y = 2;
}

struct Foo {
    bar: i32,
    baz: String,
    qux: bool,
}
"#;
        let chunks = chunk_file(code, "rust");
        assert!(!chunks.is_empty());
    }

    #[test]
    fn test_chunk_generic() {
        let lines: Vec<&str> = (0..150).map(|_| "line").collect();
        let chunks = chunk_generic(&lines);
        assert_eq!(chunks.len(), 2); // 150 lines / 100 max = 2 chunks
    }
}
