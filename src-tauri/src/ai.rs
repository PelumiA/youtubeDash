//! Claude vision critique for thumbnails (the advisory "hook" dimension).
//!
//! Raw HTTP to the Messages API (there is no official Rust SDK). The API key comes from
//! `ANTHROPIC_API_KEY` or the OS credential store and never reaches the webview. Results are
//! cached per image fingerprint + platform + title, so re-opening a test costs nothing.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

use crate::db;

pub const MODEL: &str = "claude-opus-5-5";
const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2026-10-21";
/// Server-side refusal fallback, "default" form: Anthropic picks the fallback model.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Bump when the prompt or schema changes so cached critiques are not reused.
const PROMPT_VERSION: u32 = 1;
const KEYRING_SERVICE: &str = "creator-dashboard";
const KEYRING_USER: &str = "anthropic-api-key";
/// The API accepts images up to 5 MB; base64 adds a third.
const MAX_BASE64_LEN: usize = 5 * 1024 * 1024 * 4 / 3;

const SYSTEM_PROMPT: &str = "You review video thumbnails for a solo content creator. Judge the image the way a viewer \
scrolling a feed sees it: small, for about one second, next to the video title.

Text contrast, text size, and overlap with platform UI overlays are measured separately by the app, so do not score or \
comment on those. Focus on the hook: is there a clear story or question, does it create curiosity that the title pays \
off (without repeating the title), what emotion does it read as, and is the main subject instantly recognisable.

hook_score is 0-10 where 5 is an ordinary, competent thumbnail and 8+ would stand out in a busy feed. Each critique \
bullet is one concrete observation plus the change you would make, in under 25 words. Give 3 to 5 bullets.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Critique {
    pub model: String,
    pub hook_score: f64,
    pub reads_in_one_second: bool,
    pub emotion: String,
    pub story: String,
    pub subject_note: String,
    pub critique: Vec<String>,
    #[serde(default)]
    pub cached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub configured: bool,
    /// "env" or "keychain"
    pub source: Option<String>,
    pub model: String,
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

fn api_key() -> Option<(String, &'static str)> {
    if let Ok(k) = std::env::var("ANTHROPIC_API_KEY") {
        if !k.trim().is_empty() {
            return Some((k.trim().to_string(), "env"));
        }
    }
    keyring_entry().ok()?.get_password().ok().map(|k| (k, "keychain"))
}

pub fn status() -> AiStatus {
    let source = api_key().map(|(_, s)| s.to_string());
    AiStatus { configured: source.is_some(), source, model: MODEL.into() }
}

pub fn set_key(key: &str) -> Result<(), String> {
    let key = key.trim();
    if !key.starts_with("sk-ant-") || key.len() < 20 {
        return Err("That doesn't look like an Anthropic API key (they start with sk-ant-).".into());
    }
    keyring_entry()?.set_password(key).map_err(|e| format!("Could not save to the system keychain: {e}"))
}

pub fn clear_key() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "hook_score": { "type": "integer", "description": "0-10" },
            "reads_in_one_second": { "type": "boolean" },
            "emotion": { "type": "string", "description": "The emotion the thumbnail reads as, a few words." },
            "story": { "type": "string", "description": "The story or question a viewer infers, one sentence." },
            "subject_note": { "type": "string", "description": "Is the main subject instantly recognisable? One sentence." },
            "critique": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["hook_score", "reads_in_one_second", "emotion", "story", "subject_note", "critique"],
        "additionalProperties": false
    })
}

pub fn build_request(image_base64: &str, platform: &str, title: &str) -> Value {
    let placement = if platform == "instagram" {
        "an Instagram Reels cover (9:16), seen in the Reels feed and as a small 3:4 tile on the profile grid"
    } else {
        "a YouTube thumbnail (16:9), seen in the home feed and the Up next sidebar"
    };
    let title_line = if title.trim().is_empty() { "No title was given.".to_string() } else { format!("Video title: \"{}\"", title.trim()) };
    json!({
        "model": MODEL,
        "max_tokens": 16000,
        "system": SYSTEM_PROMPT,
        "output_config": { "effort": "medium", "format": { "type": "json_schema", "schema": schema() } },
        "fallbacks": "default",
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": image_base64 } },
                { "type": "text", "text": format!("This is {placement}. {title_line}\nCritique the hook.") }
            ]
        }]
    })
}

#[derive(Deserialize)]
struct Raw {
    hook_score: f64,
    reads_in_one_second: bool,
    emotion: String,
    story: String,
    subject_note: String,
    critique: Vec<String>,
}

/// Parses a Messages API response body into a critique, handling refusals.
pub fn parse_response(body: &Value) -> Result<Critique, String> {
    if body["stop_reason"] == "refusal" {
        let category = body["stop_details"]["category"].as_str().unwrap_or("unspecified");
        return Err(format!("Claude declined to critique this image (category: {category})."));
    }
    if body["stop_reason"] == "max_tokens" {
        return Err("The critique was cut off before it finished. Try again.".into());
    }
    let text = body["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "text"))
        .and_then(|b| b["text"].as_str())
        .ok_or("The response had no text block.")?;
    let raw: Raw = serde_json::from_str(text).map_err(|e| format!("Unexpected response format: {e}"))?;
    Ok(Critique {
        model: body["model"].as_str().unwrap_or(MODEL).to_string(),
        hook_score: raw.hook_score.clamp(0.0, 10.0),
        reads_in_one_second: raw.reads_in_one_second,
        emotion: raw.emotion,
        story: raw.story,
        subject_note: raw.subject_note,
        critique: raw.critique.into_iter().take(5).collect(),
        cached: false,
    })
}

fn cache_key(file_hash: &str, platform: &str, title: &str) -> String {
    let mut h = blake3::Hasher::new();
    for part in [file_hash, platform, title.trim(), MODEL, &PROMPT_VERSION.to_string()] {
        h.update(part.as_bytes());
        h.update(&[0]);
    }
    h.finalize().to_hex().to_string()
}

pub fn cached(conn: &Connection, file_hash: &str, platform: &str, title: &str) -> Option<Critique> {
    let json: Option<String> = conn
        .query_row("SELECT response FROM ai_cache WHERE cache_key = ?1", params![cache_key(file_hash, platform, title)], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    json.and_then(|j| serde_json::from_str::<Critique>(&j).ok()).map(|c| Critique { cached: true, ..c })
}

pub fn store(conn: &Connection, file_hash: &str, platform: &str, title: &str, c: &Critique) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_cache (cache_key, response, created_at) VALUES (?1, ?2, ?3)",
        params![cache_key(file_hash, platform, title), serde_json::to_string(c).expect("serialize"), db::now()],
    )?;
    Ok(())
}

/// Calls the API. Blocking; run off the main thread.
pub fn request_critique(image_base64: &str, platform: &str, title: &str) -> Result<Critique, String> {
    let (key, _) = api_key().ok_or("No API key set. Add one under Scoring settings to enable the AI critique.")?;
    if image_base64.len() > MAX_BASE64_LEN {
        return Err("Image is too large to send (5 MB limit).".into());
    }
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(180)).build();
    let resp = agent
        .post(API_URL)
        .set("x-api-key", &key)
        .set("anthropic-version", API_VERSION)
        .set("anthropic-beta", FALLBACK_BETA)
        .set("content-type", "application/json")
        .send_json(build_request(image_base64, platform, title));
    let body: Value = match resp {
        Ok(r) => r.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_json::<Value>().ok().and_then(|v| v["error"]["message"].as_str().map(String::from)).unwrap_or_default();
            return Err(match code {
                401 | 403 => "The API key was rejected. Check it under Scoring settings.".into(),
                429 => "Rate limited by the API. Wait a moment and try again.".into(),
                529 | 500..=599 => format!("The API is temporarily unavailable ({code}). Try again shortly."),
                _ => format!("API error {code}: {detail}"),
            });
        }
        Err(ureq::Error::Transport(t)) => return Err(format!("Could not reach the API (offline?): {t}")),
    };
    parse_response(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_has_image_schema_and_fallback() {
        let r = build_request("QUJD", "youtube", "Leg day, fixed");
        assert_eq!(r["model"], MODEL);
        assert_eq!(r["fallbacks"], "default");
        assert_eq!(r["output_config"]["format"]["type"], "json_schema");
        assert_eq!(r["output_config"]["format"]["schema"]["additionalProperties"], false);
        assert_eq!(r["messages"][0]["content"][0]["source"]["data"], "QUJD");
        assert!(r["messages"][0]["content"][1]["text"].as_str().unwrap().contains("\"Leg day, fixed\""));
        assert!(r.get("temperature").is_none() && r.get("thinking").is_none());
    }

    #[test]
    fn parses_success_refusal_and_truncation() {
        let ok = json!({
            "model": "claude-opus-5-5", "stop_reason": "end_turn",
            "content": [{ "type": "thinking", "thinking": "" }, { "type": "text", "text": r#"{"hook_score": 12, "reads_in_one_second": true, "emotion": "surprise", "story": "A fix for leg day.", "subject_note": "Clear face.", "critique": ["a","b","c","d","e","f"]}"# }]
        });
        let c = parse_response(&ok).unwrap();
        assert_eq!(c.hook_score, 10.0, "clamped");
        assert_eq!(c.critique.len(), 5, "capped");
        let refusal = json!({ "stop_reason": "refusal", "stop_details": { "category": "cyber" }, "content": [] });
        assert!(parse_response(&refusal).unwrap_err().contains("declined"));
        assert!(parse_response(&json!({ "stop_reason": "max_tokens", "content": [] })).is_err());
    }

    #[test]
    fn cache_round_trip_is_keyed_by_image_platform_and_title() {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        let crit = Critique { model: MODEL.into(), hook_score: 7.0, reads_in_one_second: true, emotion: "e".into(), story: "s".into(), subject_note: "n".into(), critique: vec![], cached: false };
        store(&c, "fp:1", "youtube", "Title", &crit).unwrap();
        assert!(cached(&c, "fp:1", "youtube", "Title").unwrap().cached);
        assert!(cached(&c, "fp:1", "youtube", "Other title").is_none());
        assert!(cached(&c, "fp:1", "instagram", "Title").is_none());
    }
}
