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
///
/// Long-meeting resilience (#2366): a 1+ hour meeting yields ~5-15 chunks; if
/// any single chunk's LLM call returned empty content, the old `?` propagation
/// nuked the whole meeting. Now we collect every chunk's result and only fail
/// the whole pass when every chunk failed — see [`collect_resilient_partials`].
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
    let total_chunks = chunks.len();
    let mut results = Vec::with_capacity(total_chunks);
    for (idx, chunk) in chunks.iter().enumerate() {
        let result =
            generate_notes_single(app, model.clone(), chunk, template_prompt, vocabulary).await;
        if let Err(err) = &result {
            log::warn!(
                "[meeting] notes chunk {} of {total_chunks} failed ({err}); continuing with remaining chunks",
                idx + 1,
            );
        }
        results.push(result);
    }
    let partials = collect_resilient_partials(results)?;

    reduce_partials(app, model, partials, template_prompt, vocabulary).await
}

/// Resilience helper for the chunked notes pass and the reduce-pass re-chunk.
/// Returns the surviving `Ok` partials when any chunk succeeded; returns the
/// first `Err` only when **every** chunk failed. The chunked notes pipeline
/// used to `?`-abort on the first failing chunk, which lost the entire
/// meeting whenever one chunk hit an upstream blip; this helper makes the
/// pipeline degrade to a partial summary rather than total data loss. #2366.
pub fn collect_resilient_partials(
    results: Vec<Result<ParsedNotes, String>>,
) -> Result<Vec<ParsedNotes>, String> {
    let mut partials = Vec::with_capacity(results.len());
    let mut first_error: Option<String> = None;
    for result in results {
        match result {
            Ok(notes) => partials.push(notes),
            Err(err) => {
                if first_error.is_none() {
                    first_error = Some(err);
                }
            }
        }
    }
    if partials.is_empty() {
        Err(first_error.unwrap_or_else(|| "no chunks produced notes".to_string()))
    } else {
        Ok(partials)
    }
}

/// Reduce N partial notes into one. If the combined sections exceed
/// [`TRANSCRIPT_CHAR_BUDGET`], re-chunk + re-summarize and loop — so a
/// 4-hour meeting that produces too many partials to fit in one prompt
/// still converges instead of silently overflowing on the reduce pass.
async fn reduce_partials(
    app: &tauri::AppHandle,
    model: String,
    mut partials: Vec<ParsedNotes>,
    template_prompt: &str,
    vocabulary: &[String],
) -> Result<ParsedNotes, String> {
    let reduce_template = format!(
        "This meeting was very long; the input below is an ordered list of \
         section summaries from earlier passes. Produce ONE coherent set of \
         meeting notes that subsumes them. {template_prompt}",
        template_prompt = template_prompt.trim(),
    );
    // Cap iterations so a misbehaving model that fails to shrink output can't
    // spin forever. In practice 1-2 rounds suffice for any realistic meeting.
    for _ in 0..MAX_REDUCE_ROUNDS {
        let combined = combine_partials_text(&partials);
        if partials.len() <= 1 || combined.chars().count() <= TRANSCRIPT_CHAR_BUDGET {
            return finalize_reduce(
                app,
                model,
                &combined,
                &reduce_template,
                vocabulary,
                &partials,
            )
            .await;
        }
        let sub_chunks = chunk_transcript_by_chars(&combined, TRANSCRIPT_CHAR_BUDGET);
        if sub_chunks.len() >= partials.len() {
            log::warn!(
                "[meeting] reduce loop not shrinking ({} -> {} sub-chunks); finalizing",
                partials.len(),
                sub_chunks.len(),
            );
            return finalize_reduce(
                app,
                model,
                &combined,
                &reduce_template,
                vocabulary,
                &partials,
            )
            .await;
        }
        let mut sub_results = Vec::with_capacity(sub_chunks.len());
        for chunk in sub_chunks.iter() {
            sub_results.push(
                generate_notes_single(app, model.clone(), chunk, &reduce_template, vocabulary)
                    .await,
            );
        }
        partials = collect_resilient_partials(sub_results)?;
    }
    let combined = combine_partials_text(&partials);
    finalize_reduce(
        app,
        model,
        &combined,
        &reduce_template,
        vocabulary,
        &partials,
    )
    .await
}

/// Final-reduce wrapper: tries one model call to produce a single coherent
/// note set. If that returns "no content" or fails, falls back to a notes
/// object synthesized from the partials so the user still gets the per-
/// section markdown plus a union of action items and fields — instead of
/// the all-or-nothing failure that #2366 surfaced.
async fn finalize_reduce(
    app: &tauri::AppHandle,
    model: String,
    combined: &str,
    reduce_template: &str,
    vocabulary: &[String],
    partials: &[ParsedNotes],
) -> Result<ParsedNotes, String> {
    match generate_notes_single(app, model, combined, reduce_template, vocabulary).await {
        Ok(notes) => Ok(notes),
        Err(err) => {
            log::warn!(
                "[meeting] reduce pass failed ({err}); returning combined per-section notes"
            );
            Ok(notes_from_partials(combined, partials))
        }
    }
}

/// Synthesize a ParsedNotes from the chunked partials when the reduce model
/// call fails. The markdown is the already-rendered combined per-section
/// text; action items are unioned (de-duped by trimmed text) and fields are
/// merged (first-write-wins to preserve earliest-section evidence).
fn notes_from_partials(combined: &str, partials: &[ParsedNotes]) -> ParsedNotes {
    let mut action_items: Vec<String> = Vec::new();
    let mut seen_actions: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut summaries: Vec<String> = Vec::new();
    let mut fields: BTreeMap<String, Value> = BTreeMap::new();
    for partial in partials {
        if !partial.structured.summary.trim().is_empty() {
            summaries.push(partial.structured.summary.trim().to_string());
        }
        for item in &partial.structured.action_items {
            let key = item.trim().to_string();
            if key.is_empty() || !seen_actions.insert(key.clone()) {
                continue;
            }
            action_items.push(key);
        }
        for (key, value) in &partial.structured.fields {
            fields.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    ParsedNotes {
        markdown: combined.to_string(),
        structured: StructuredNotes {
            summary: summaries.join(" / "),
            action_items,
            fields,
        },
    }
}

const MAX_REDUCE_ROUNDS: usize = 4;

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

/// Render a set of partial notes as a single reducer-ready string. Structured
/// fields (`summary`, `action_items`, `fields`) are surfaced as plain text so
/// the reduce-pass model can roll them up — without this, chunked notes would
/// silently drop action items whenever the reducer fails to re-emit JSON.
fn combine_partials_text(partials: &[ParsedNotes]) -> String {
    partials
        .iter()
        .enumerate()
        .map(|(idx, partial)| {
            let mut section = format!("## Section {}\n{}", idx + 1, partial.markdown.trim());
            if !partial.structured.summary.is_empty() {
                section.push_str(&format!(
                    "\n\nSection summary: {}",
                    partial.structured.summary.trim()
                ));
            }
            if !partial.structured.action_items.is_empty() {
                section.push_str("\n\nSection action items:");
                for item in &partial.structured.action_items {
                    section.push_str(&format!("\n- {}", item.trim()));
                }
            }
            if !partial.structured.fields.is_empty() {
                if let Ok(fields_json) = serde_json::to_string(&partial.structured.fields) {
                    section.push_str(&format!("\n\nSection fields (JSON): {fields_json}"));
                }
            }
            section
        })
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

    #[test]
    fn combine_partials_preserves_action_items_and_fields_for_reducer() {
        use serde_json::json;
        let mut fields_a = BTreeMap::new();
        fields_a.insert("company".to_string(), json!("Acme"));
        let mut fields_b = BTreeMap::new();
        fields_b.insert("owner".to_string(), json!("Jane"));

        let partials = vec![
            ParsedNotes {
                markdown: "# Section A".into(),
                structured: StructuredNotes {
                    summary: "Discovery call".into(),
                    action_items: vec!["Send recap".into(), "Draft contract".into()],
                    fields: fields_a,
                },
            },
            ParsedNotes {
                markdown: "# Section B".into(),
                structured: StructuredNotes {
                    summary: "Pricing alignment".into(),
                    action_items: vec!["Confirm budget".into()],
                    fields: fields_b,
                },
            },
        ];

        let combined = combine_partials_text(&partials);

        // Every action item is visible to the reducer model.
        assert!(combined.contains("Send recap"), "missing action item 1");
        assert!(combined.contains("Draft contract"), "missing action item 2");
        assert!(combined.contains("Confirm budget"), "missing action item 3");
        // Every field key is visible.
        assert!(combined.contains("company"), "missing field key 'company'");
        assert!(combined.contains("owner"), "missing field key 'owner'");
        // Per-section summaries are visible.
        assert!(combined.contains("Discovery call"), "missing summary A");
        assert!(combined.contains("Pricing alignment"), "missing summary B");
    }

    #[test]
    fn combine_partials_skips_empty_structured_segments_cleanly() {
        let partials = vec![ParsedNotes {
            markdown: "# Just markdown".into(),
            structured: StructuredNotes::default(),
        }];

        let combined = combine_partials_text(&partials);

        // No stray "Section action items:" header when the partial has none.
        assert!(!combined.contains("Section action items"));
        assert!(!combined.contains("Section fields"));
        assert!(combined.contains("# Just markdown"));
    }

    fn sample_partial(label: &str) -> ParsedNotes {
        ParsedNotes {
            markdown: format!("# {label}"),
            structured: StructuredNotes {
                summary: format!("{label} summary"),
                action_items: vec![format!("{label} action")],
                fields: BTreeMap::new(),
            },
        }
    }

    #[test]
    fn collect_resilient_partials_drops_empty_failures_when_some_chunks_succeed() {
        // The #2366 shape: chunk 2 of a long meeting returns "no content";
        // chunks 1 and 3 succeed. Old behavior `?`-aborted on chunk 2 and lost
        // the whole meeting. New behavior returns the two surviving partials.
        let results = vec![
            Ok(sample_partial("A")),
            Err("chat completion returned no content".to_string()),
            Ok(sample_partial("C")),
        ];

        let partials = collect_resilient_partials(results).expect("survivors");

        assert_eq!(partials.len(), 2);
        assert_eq!(partials[0].markdown, "# A");
        assert_eq!(partials[1].markdown, "# C");
    }

    #[test]
    fn collect_resilient_partials_surfaces_first_error_when_every_chunk_failed() {
        // All-empty case must still error out so the user sees a failure
        // banner instead of an empty notes panel.
        let results: Vec<Result<ParsedNotes, String>> = vec![
            Err("chat completion returned no content".to_string()),
            Err("chat completion upstream 429: rate limited".to_string()),
        ];

        let err = collect_resilient_partials(results).expect_err("all-fail surfaces error");

        assert_eq!(err, "chat completion returned no content");
    }

    #[test]
    fn collect_resilient_partials_passes_through_all_successful_chunks() {
        let results = vec![Ok(sample_partial("A")), Ok(sample_partial("B"))];

        let partials = collect_resilient_partials(results).expect("all-ok passes");

        assert_eq!(partials.len(), 2);
    }

    #[test]
    fn notes_from_partials_unions_action_items_and_fields_for_fallback() {
        // When the final reduce-pass model call returns empty, we synthesize
        // notes from the partials so the user keeps per-section content plus a
        // de-duped union of action items / merged fields — instead of total
        // data loss (#2366).
        let mut fields_a = BTreeMap::new();
        fields_a.insert("company".to_string(), serde_json::json!("Acme"));
        let mut fields_b = BTreeMap::new();
        fields_b.insert("owner".to_string(), serde_json::json!("Jane"));
        fields_b.insert("company".to_string(), serde_json::json!("Other")); // dup key — first wins

        let partials = vec![
            ParsedNotes {
                markdown: "# A".into(),
                structured: StructuredNotes {
                    summary: "Discovery".into(),
                    action_items: vec!["Send recap".into(), "Send recap".into()], // dup
                    fields: fields_a,
                },
            },
            ParsedNotes {
                markdown: "# B".into(),
                structured: StructuredNotes {
                    summary: "Pricing".into(),
                    action_items: vec!["Confirm budget".into()],
                    fields: fields_b,
                },
            },
        ];

        let combined = "# A\n\n# B";
        let fallback = notes_from_partials(combined, &partials);

        assert_eq!(fallback.markdown, combined);
        assert_eq!(fallback.structured.summary, "Discovery / Pricing");
        assert_eq!(
            fallback.structured.action_items,
            vec!["Send recap".to_string(), "Confirm budget".to_string()]
        );
        assert_eq!(
            fallback
                .structured
                .fields
                .get("company")
                .and_then(Value::as_str),
            Some("Acme"),
            "first-write-wins for duplicate keys"
        );
        assert_eq!(
            fallback
                .structured
                .fields
                .get("owner")
                .and_then(Value::as_str),
            Some("Jane")
        );
    }
}
