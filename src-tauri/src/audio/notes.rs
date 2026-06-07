// ABOUTME: Parses Tier-1 meeting notes output into markdown plus structured data.
// ABOUTME: Fails closed on malformed model JSON while preserving readable notes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StructuredNotes {
    pub summary: String,
    pub action_items: Vec<String>,
    pub fields: BTreeMap<String, Value>,
}

impl Default for StructuredNotes {
    fn default() -> Self {
        Self {
            summary: String::new(),
            action_items: Vec::new(),
            fields: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedNotes {
    pub markdown: String,
    pub structured: StructuredNotes,
}

#[derive(Debug, Deserialize)]
struct NotesBlock {
    summary: Option<String>,
    action_items: Option<Vec<Value>>,
    fields: Option<BTreeMap<String, Value>>,
}

pub fn parse_notes_output(raw: &str) -> ParsedNotes {
    let Some((before, json, after)) = extract_json_fence(raw) else {
        return ParsedNotes {
            markdown: raw.trim().to_string(),
            structured: StructuredNotes::default(),
        };
    };

    let markdown = [before.trim(), after.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");

    match serde_json::from_str::<NotesBlock>(&json) {
        Ok(block) => ParsedNotes {
            markdown,
            structured: StructuredNotes {
                summary: block.summary.unwrap_or_default(),
                action_items: block
                    .action_items
                    .unwrap_or_default()
                    .into_iter()
                    .filter_map(action_item_to_text)
                    .collect(),
                fields: block.fields.unwrap_or_default(),
            },
        },
        Err(_) => ParsedNotes {
            markdown: raw.trim().to_string(),
            structured: StructuredNotes::default(),
        },
    }
}

fn extract_json_fence(raw: &str) -> Option<(&str, String, &str)> {
    let fence_start = raw.find("```json")?;
    let content_start = raw[fence_start..].find('\n')? + fence_start + 1;
    let fence_end = raw[content_start..].find("```")? + content_start;
    Some((
        &raw[..fence_start],
        raw[content_start..fence_end].trim().to_string(),
        &raw[fence_end + 3..],
    ))
}

fn action_item_to_text(value: Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Object(map) => ["title", "text", "description"]
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_str))
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

/// Build the Tier-1 notes prompt for a transcript under a template, reusing the
/// shared cleanup engine so notes and dictation never diverge on vocabulary.
pub fn build_notes_prompt(transcript: &str, template_prompt: &str, vocabulary: &[String]) -> String {
    format!(
        "You are taking structured notes from a meeting transcript.\n\n\
         {cleanup}\n\n\
         Notes focus: {template}\n\n\
         Write concise markdown notes (short headers and bullet points). After the \
         markdown, append a fenced ```json block with exactly this shape: \
         {{\"summary\": string, \"action_items\": string[], \"fields\": object}}. \
         Do not add commentary outside the notes and the JSON block.\n\n\
         Transcript:\n{transcript}",
        cleanup = crate::audio::cleanup::cleanup_directives(vocabulary),
        template = template_prompt.trim(),
        transcript = transcript.trim(),
    )
}

/// Generate Tier-1 notes: prompt the selected model, then parse markdown + struct.
/// Returns parsed notes even when the model omits the JSON block (parser fails safe).
pub async fn generate_notes(
    app: &tauri::AppHandle,
    model: String,
    transcript: &str,
    template_prompt: &str,
    vocabulary: &[String],
) -> Result<ParsedNotes, String> {
    let prompt = build_notes_prompt(transcript, template_prompt, vocabulary);
    let raw = crate::audio::llm::complete(
        app,
        crate::audio::llm::CompletionRequest {
            model,
            system: None,
            prompt,
        },
    )
    .await?;
    Ok(parse_notes_output(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_notes_output_extracts_markdown_and_structured_block() {
        let raw = r#"# Notes

- Good call.

```json
{
  "summary": "Discovery call",
  "action_items": ["Send recap", {"title": "Draft proposal"}],
  "fields": {"company": "Acme"}
}
```
"#;

        let parsed = parse_notes_output(raw);

        assert_eq!(parsed.markdown, "# Notes\n\n- Good call.");
        assert_eq!(parsed.structured.summary, "Discovery call");
        assert_eq!(
            parsed.structured.action_items,
            vec!["Send recap".to_string(), "Draft proposal".to_string()]
        );
        assert_eq!(
            parsed
                .structured
                .fields
                .get("company")
                .and_then(Value::as_str),
            Some("Acme")
        );
    }

    #[test]
    fn parse_notes_output_falls_back_when_json_missing() {
        let raw = "# Notes\n\nNo JSON today.";

        let parsed = parse_notes_output(raw);

        assert_eq!(parsed.markdown, raw);
        assert_eq!(parsed.structured, StructuredNotes::default());
    }

    #[test]
    fn parse_notes_output_falls_back_when_json_is_malformed() {
        let raw = "# Notes\n\n```json\n{\"summary\":\n```\n";

        let parsed = parse_notes_output(raw);

        assert_eq!(parsed.markdown, raw.trim());
        assert_eq!(parsed.structured, StructuredNotes::default());
    }
}
