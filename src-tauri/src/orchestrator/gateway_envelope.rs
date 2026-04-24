// ABOUTME: Helpers for Seren Gateway publisher response envelopes.

use serde_json::Value;

/// Strip Seren's DataResponse<T> envelope when the object has only `data`
/// and optionally `pagination`.
///
/// This intentionally does not strip upstream protocol payloads like OpenAI's
/// `{ object, data, model, usage }`, where `data` is part of the protocol body.
pub fn unwrap_data_response(value: &Value) -> &Value {
    let Some(obj) = value.as_object() else {
        return value;
    };
    if !obj.contains_key("data") {
        return value;
    }
    if obj.keys().any(|key| key != "data" && key != "pagination") {
        return value;
    }
    obj.get("data").unwrap_or(value)
}

/// Strip both Seren's outer DataResponse<T> envelope and the publisher proxy
/// `{ status, body, cost, ... }` envelope when present.
pub fn unwrap_publisher_body(value: &Value) -> &Value {
    let inner = unwrap_data_response(value);
    match inner.as_object() {
        Some(obj) if obj.contains_key("body") && obj.contains_key("status") => {
            obj.get("body").unwrap_or(inner)
        }
        _ => inner,
    }
}

/// Extract the upstream provider status from a publisher proxy response.
pub fn publisher_status(value: &Value) -> Option<u64> {
    unwrap_data_response(value)
        .as_object()
        .and_then(|obj| obj.get("status"))
        .and_then(Value::as_u64)
}

/// Extract the cost from a publisher proxy response.
pub fn publisher_cost(value: &Value) -> Option<f64> {
    unwrap_data_response(value)
        .as_object()
        .and_then(|obj| obj.get("cost"))
        .and_then(|value| {
            value
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
                .or_else(|| value.as_f64())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwrap_publisher_body_strips_data_response_and_publisher_envelope() {
        let wrapped = serde_json::json!({
            "data": {
                "status": 200,
                "body": { "choices": [{ "message": { "content": "hi" } }] },
                "cost": "0.001"
            }
        });

        let body = unwrap_publisher_body(&wrapped);
        assert_eq!(body["choices"][0]["message"]["content"], "hi");
    }

    #[test]
    fn unwrap_data_response_does_not_strip_protocol_data_payloads() {
        let openai_list = serde_json::json!({
            "object": "list",
            "data": [{ "id": "model-a" }],
            "model": "model-a",
            "usage": { "total_tokens": 1 }
        });

        let unwrapped = unwrap_data_response(&openai_list);
        assert!(std::ptr::eq(unwrapped, &openai_list));
    }

    #[test]
    fn unwrap_data_response_preserves_data_null_payloads() {
        let wrapped = serde_json::json!({
            "data": null
        });

        let unwrapped = unwrap_data_response(&wrapped);
        assert_eq!(unwrapped, &Value::Null);
    }

    #[test]
    fn publisher_status_and_cost_read_through_data_response() {
        let wrapped = serde_json::json!({
            "data": {
                "status": 429,
                "body": { "error": { "message": "rate limited" } },
                "cost": "0.000123"
            }
        });

        assert_eq!(publisher_status(&wrapped), Some(429));
        assert_eq!(publisher_cost(&wrapped), Some(0.000123));
    }

    #[test]
    fn unwrap_publisher_body_preserves_raw_chat_payloads() {
        let raw = serde_json::json!({
            "choices": [{ "message": { "content": "hi" } }]
        });

        let body = unwrap_publisher_body(&raw);
        assert!(std::ptr::eq(body, &raw));
    }
}
