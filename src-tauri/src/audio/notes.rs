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

/// Character budget per Tier-1 notes pass. Long meetings get chunked into windows
/// under this size so the model context never overflows. ~24K chars ≈ 6K tokens,
/// which leaves headroom on small-context (8K) and large-context (200K+) providers.
pub const TRANSCRIPT_CHAR_BUDGET: usize = 24_000;

/// Generate Tier-1 notes: prompt the selected model, then parse markdown + struct.
/// Long transcripts (over [`TRANSCRIPT_CHAR_BUDGET`]) are summarized in line-aligned
/// chunks, then reduced into a single set of notes — so a 60-minute meeting won't
/// exceed the model's context. Returns parsed notes even when the model omits the
/// JSON block (parser fails safe).
pub async fn generate_notes(
    app: &tauri::AppHandle,
    model: String,
    transcript: &str,
    template_prompt: &str,
    vocabulary: &[String],
) -> Result<ParsedNotes, String> {
    if transcript.chars().count() <= TRANSCRIPT_CHAR_BUDGET {
        return generate_notes_single(app, model, transcript, template_prompt, vocabulary).await;
    }

    let chunks = chunk_transcript_by_chars(transcript, TRANSCRIPT_CHAR_BUDGET);
    let mut partials = Vec::with_capacity(chunks.len());
    for chunk in chunks.iter() {
        let partial =
            generate_notes_single(app, model.clone(), chunk, template_prompt, vocabulary).await?;
        partials.push(partial);
    }

    let combined = combine_partials_text(&partials);
    let reduce_template = format!(
        "This meeting was very long; the input below is an ordered list of \
         section summaries from earlier passes. Produce ONE coherent set of \
         meeting notes that subsumes them. {template_prompt}",
        template_prompt = template_prompt.trim(),
    );
    generate_notes_single(app, model, &combined, &reduce_template, vocabulary).await
}

async fn generate_notes_single(
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

/// Split `transcript` into chunks no larger than `budget` chars, breaking on line
/// boundaries so a "Me:"/"Them:" utterance is never split mid-text. A single line
/// longer than `budget` is hard-split into `budget`-sized pieces so callers never
/// produce a chunk that would overflow the model context.
pub fn chunk_transcript_by_chars(transcript: &str, budget: usize) -> Vec<String> {
    assert!(budget > 0, "transcript budget must be > 0");
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in transcript.split('\n') {
        if line.chars().count() > budget {
            if !current.is_empty() {
                chunks.push(std::mem::take(&mut current));
            }
            for piece in hard_split(line, budget) {
                chunks.push(piece);
            }
            continue;
        }
        let separator = if current.is_empty() { 0 } else { 1 };
        if current.chars().count() + separator + line.chars().count() > budget {
            chunks.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(line);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn hard_split(line: &str, budget: usize) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut buffer = String::new();
    for ch in line.chars() {
        if buffer.chars().count() == budget {
            pieces.push(std::mem::take(&mut buffer));
        }
        buffer.push(ch);
    }
    if !buffer.is_empty() {
        pieces.push(buffer);
    }
    pieces
}

fn combine_partials_text(partials: &[ParsedNotes]) -> String {
    partials
        .iter()
        .enumerate()
        .map(|(idx, partial)| format!("## Section {}\n{}", idx + 1, partial.markdown.trim()))
        .collect::<Vec<_>>()
        .join("\n\n")
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

    #[test]
    fn chunk_transcript_packs_lines_under_budget_and_preserves_every_line() {
        let transcript = (1..=12)
            .map(|i| format!("Me: utterance number {i}"))
            .collect::<Vec<_>>()
            .join("\n");

        let chunks = chunk_transcript_by_chars(&transcript, 60);

        assert!(chunks.len() > 1, "long transcript should chunk");
        for chunk in &chunks {
            assert!(
                chunk.chars().count() <= 60,
                "chunk exceeds budget: {} chars",
                chunk.chars().count()
            );
        }
        // Every line preserved exactly once, no chunk splits a line mid-text.
        let joined = chunks.join("\n");
        for line in transcript.split('\n') {
            assert!(joined.contains(line), "missing line: {line}");
        }
    }

    #[test]
    fn chunk_transcript_returns_single_chunk_when_under_budget() {
        let transcript = "Me: hi\nThem: hello";

        let chunks = chunk_transcript_by_chars(transcript, 1000);

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], transcript);
    }

    #[test]
    fn chunk_transcript_hard_splits_a_single_line_that_exceeds_budget() {
        let huge = "x".repeat(150);
        let transcript = format!("Me: {huge}");

        let chunks = chunk_transcript_by_chars(&transcript, 50);

        for chunk in &chunks {
            assert!(
                chunk.chars().count() <= 50,
                "hard-split chunk over budget"
            );
        }
        assert_eq!(chunks.concat().chars().count(), transcript.chars().count());
    }
}
