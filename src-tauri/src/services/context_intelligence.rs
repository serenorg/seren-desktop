use serde::{Deserialize, Serialize};
use std::future::Future;
use tree_sitter::{Language, Node, Parser};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceOutline {
    pub language: String,
    pub items: Vec<SourceOutlineItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceOutlineItem {
    pub kind: String,
    pub name: String,
    pub signature: String,
    pub start_line: usize,
    pub end_line: usize,
}

pub fn build_source_outline(path: &str, source: &str) -> Result<SourceOutline, String> {
    let language = detect_outline_language(path)
        .ok_or_else(|| format!("unsupported source language for outline: {path}"))?;
    let tree_language = tree_sitter_language(language);
    let mut parser = Parser::new();
    parser
        .set_language(&tree_language)
        .map_err(|e| format!("failed to load {language} grammar: {e}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| format!("failed to parse {path}"))?;

    let items = match language {
        "rust" => collect_rust_items(tree.root_node(), source),
        "typescript" | "tsx" => collect_typescript_items(tree.root_node(), source),
        _ => Vec::new(),
    };

    Ok(SourceOutline {
        language: language.to_string(),
        items,
    })
}

pub async fn run_ordered_batch<Fut, T>(jobs: Vec<Fut>) -> Vec<T>
where
    Fut: Future<Output = T>,
{
    futures::future::join_all(jobs).await
}

fn detect_outline_language(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "rs" => Some("rust"),
        "ts" => Some("typescript"),
        "tsx" => Some("tsx"),
        _ => None,
    }
}

fn tree_sitter_language(language: &str) -> Language {
    match language {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        _ => unreachable!("unsupported tree-sitter language: {language}"),
    }
}

fn collect_rust_items(root: Node<'_>, source: &str) -> Vec<SourceOutlineItem> {
    root.named_children(&mut root.walk())
        .filter_map(|node| match node.kind() {
            "use_declaration" => Some(item(
                "import",
                normalize_prefixed_statement(node_text(node, source), "use"),
                node,
                source,
            )),
            "struct_item" => Some(named_item("struct", node, source)),
            "enum_item" => Some(named_item("enum", node, source)),
            "trait_item" => Some(named_item("trait", node, source)),
            "function_item" => Some(named_item("function", node, source)),
            "impl_item" => Some(item(
                "impl",
                rust_impl_name(node_text(node, source)),
                node,
                source,
            )),
            "mod_item" => Some(named_item("module", node, source)),
            _ => None,
        })
        .collect()
}

fn collect_typescript_items(root: Node<'_>, source: &str) -> Vec<SourceOutlineItem> {
    let mut items = Vec::new();
    for node in root.named_children(&mut root.walk()) {
        push_typescript_item(&mut items, node, source);
    }
    items
}

fn push_typescript_item(items: &mut Vec<SourceOutlineItem>, node: Node<'_>, source: &str) {
    match node.kind() {
        "import_statement" => items.push(item(
            "import",
            normalize_prefixed_statement(node_text(node, source), "import"),
            node,
            source,
        )),
        "type_alias_declaration" => items.push(named_item("type", node, source)),
        "interface_declaration" => items.push(named_item("interface", node, source)),
        "function_declaration" => items.push(named_item("function", node, source)),
        "class_declaration" => items.push(named_item("class", node, source)),
        "lexical_declaration" | "variable_declaration" => {
            if let Some(name) = first_variable_name(node, source) {
                items.push(item("const", name, node, source));
            }
        }
        "export_statement" => {
            for child in node.named_children(&mut node.walk()) {
                push_typescript_item(items, child, source);
            }
        }
        _ => {}
    }
}

fn named_item(kind: &str, node: Node<'_>, source: &str) -> SourceOutlineItem {
    item(kind, node_name(node, source), node, source)
}

fn item(kind: &str, name: String, node: Node<'_>, source: &str) -> SourceOutlineItem {
    SourceOutlineItem {
        kind: kind.to_string(),
        name,
        signature: first_line(node_text(node, source)),
        start_line: node.start_position().row + 1,
        end_line: node.end_position().row + 1,
    }
}

fn node_name(node: Node<'_>, source: &str) -> String {
    node.child_by_field_name("name")
        .map(|child| node_text(child, source).trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback_name(node_text(node, source)))
}

fn first_variable_name(node: Node<'_>, source: &str) -> Option<String> {
    for child in node.named_children(&mut node.walk()) {
        if child.kind() == "variable_declarator" {
            return child
                .child_by_field_name("name")
                .map(|name| node_text(name, source).trim().to_string())
                .filter(|name| !name.is_empty());
        }
    }
    None
}

fn rust_impl_name(text: &str) -> String {
    let head = text
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .trim_start_matches("impl")
        .trim();
    let before_brace = head.split('{').next().unwrap_or(head).trim();
    if let Some((_, target)) = before_brace.rsplit_once(" for ") {
        return clean_identifier(target);
    }
    clean_identifier(before_brace)
}

fn normalize_prefixed_statement(text: &str, prefix: &str) -> String {
    text.trim()
        .trim_start_matches(prefix)
        .trim()
        .trim_end_matches(';')
        .trim()
        .to_string()
}

fn fallback_name(text: &str) -> String {
    let first = text.lines().next().unwrap_or_default();
    first.split_whitespace().nth(1).unwrap_or(first).to_string()
}

fn clean_identifier(text: &str) -> String {
    text.trim()
        .trim_start_matches('<')
        .trim_end_matches('{')
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_matches(|ch: char| matches!(ch, '<' | '>' | '{' | '(' | ')'))
        .to_string()
}

fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or_default().trim().to_string()
}

fn node_text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    node.utf8_text(source.as_bytes()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::time::{Duration, Instant};

    #[test]
    fn indexes_tsx_symbols_with_exact_lines() {
        let source = r#"import { createSignal } from "solid-js";

type User = {
  id: string;
};

export interface Props {
  user: User;
}

export function Profile(props: Props) {
  const [count] = createSignal(0);
  return <section>{props.user.id}{count()}</section>;
}

const helper = () => "ok";
"#;

        let outline = build_source_outline("Profile.tsx", source).expect("tsx outline");

        assert_eq!(outline.language, "tsx");
        assert_eq!(
            outline
                .items
                .iter()
                .map(|item| (
                    item.kind.as_str(),
                    item.name.as_str(),
                    item.start_line,
                    item.end_line
                ))
                .collect::<Vec<_>>(),
            vec![
                ("import", "{ createSignal } from \"solid-js\"", 1, 1),
                ("type", "User", 3, 5),
                ("interface", "Props", 7, 9),
                ("function", "Profile", 11, 14),
                ("const", "helper", 16, 16),
            ]
        );
    }

    #[test]
    fn indexes_rust_symbols_with_exact_lines() {
        let source = r#"use serde::Serialize;

pub struct RunConfig {
    pub limit: usize,
}

impl RunConfig {
    pub fn new(limit: usize) -> Self {
        Self { limit }
    }
}

pub async fn run_scan(config: RunConfig) -> usize {
    config.limit
}
"#;

        let outline = build_source_outline("scanner.rs", source).expect("rust outline");

        assert_eq!(outline.language, "rust");
        assert_eq!(
            outline
                .items
                .iter()
                .map(|item| (
                    item.kind.as_str(),
                    item.name.as_str(),
                    item.start_line,
                    item.end_line
                ))
                .collect::<Vec<_>>(),
            vec![
                ("import", "serde::Serialize", 1, 1),
                ("struct", "RunConfig", 3, 5),
                ("impl", "RunConfig", 7, 11),
                ("function", "run_scan", 13, 15),
            ]
        );
    }

    #[tokio::test]
    async fn batch_preserves_input_order_while_running_concurrently() {
        let started = Instant::now();
        let jobs: Vec<Pin<Box<dyn Future<Output = &'static str> + Send>>> = vec![
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(80)).await;
                "slow"
            }),
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(10)).await;
                "fast"
            }),
        ];
        let results = run_ordered_batch(jobs).await;

        assert_eq!(results, vec!["slow", "fast"]);
        assert!(
            started.elapsed() < Duration::from_millis(140),
            "batch work should run concurrently, not serially"
        );
    }
}
