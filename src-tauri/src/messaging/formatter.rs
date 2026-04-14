// ABOUTME: Convert WorkerEvent streams into platform-appropriate message text.
// ABOUTME: Handles Telegram MarkdownV2, Discord Markdown, and WhatsApp plain text.

pub enum Platform {
    Telegram,
    Discord,
    WhatsApp,
}

pub fn format_tool_approval(platform: &Platform, name: &str, arguments: &str) -> String {
    let args_pretty = serde_json::from_str::<serde_json::Value>(arguments)
        .ok()
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
        .unwrap_or_else(|| arguments.to_string());

    match platform {
        Platform::Telegram => {
            format!(
                "🔧 *Tool Request:* `{}`\n```json\n{}\n```",
                escape_telegram_md(name),
                args_pretty
            )
        }
        Platform::Discord => {
            format!(
                "🔧 **Tool Request:** `{}`\n```json\n{}\n```",
                name, args_pretty
            )
        }
        Platform::WhatsApp => {
            format!("🔧 Tool Request: {}\n{}", name, args_pretty)
        }
    }
}

pub fn format_content(platform: &Platform, text: &str) -> String {
    match platform {
        Platform::Telegram => escape_telegram_md(text),
        Platform::Discord | Platform::WhatsApp => text.to_string(),
    }
}

pub fn format_cost(platform: &Platform, cost: f64) -> String {
    let text = format!("Cost: ${:.4}", cost);
    match platform {
        Platform::Telegram => format!("_{}_", escape_telegram_md(&text)),
        Platform::Discord => format!("*{}*", text),
        Platform::WhatsApp => text,
    }
}

pub fn format_error(platform: &Platform, message: &str) -> String {
    match platform {
        Platform::Telegram => format!("❌ {}", escape_telegram_md(message)),
        Platform::Discord => format!("❌ {}", message),
        Platform::WhatsApp => format!("Error: {}", message),
    }
}

pub fn format_balance(platform: &Platform, balance_usd: f64) -> String {
    let text = format!("SerenBucks Balance: ${:.2}", balance_usd);
    match platform {
        Platform::Telegram => format!("💰 *{}*", escape_telegram_md(&text)),
        Platform::Discord => format!("💰 **{}**", text),
        Platform::WhatsApp => format!("💰 {}", text),
    }
}

/// Escape special characters for Telegram MarkdownV2.
fn escape_telegram_md(text: &str) -> String {
    let special = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    let mut result = String::with_capacity(text.len());
    for ch in text.chars() {
        if special.contains(&ch) {
            result.push('\\');
        }
        result.push(ch);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telegram_markdown_escapes_special_chars() {
        let input = "Hello_world [test](link)";
        let escaped = escape_telegram_md(input);
        assert_eq!(escaped, "Hello\\_world \\[test\\]\\(link\\)");
    }

    #[test]
    fn format_tool_approval_includes_name_and_args() {
        let result = format_tool_approval(
            &Platform::Discord,
            "run_sql",
            r#"{"query":"SELECT 1"}"#,
        );
        assert!(result.contains("run_sql"));
        assert!(result.contains("SELECT 1"));
    }
}
