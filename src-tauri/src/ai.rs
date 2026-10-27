//! Claude calls: the thumbnail hook critique (vision) and idea categorization (text only).
//!
//! Raw HTTP to the Messages API (there is no official Rust SDK). The API key comes from
//! `ANTHROPIC_API_KEY` or the OS credential store and never reaches the webview. Results are
//! cached (per image fingerprint + platform + title, or per idea text + taxonomy), so asking
//! again costs nothing.

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
    let text = output_text(body, "critique this image")?;
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

/// POSTs a Messages request. Blocking; run off the main thread.
fn post(body: Value) -> Result<Value, String> {
    let (key, _) = api_key().ok_or("No API key set. Add an Anthropic API key in settings to use Claude.")?;
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(180)).build();
    let resp = agent
        .post(API_URL)
        .set("x-api-key", &key)
        .set("anthropic-version", API_VERSION)
        .set("anthropic-beta", FALLBACK_BETA)
        .set("content-type", "application/json")
        .send_json(body);
    match resp {
        Ok(r) => r.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_json::<Value>().ok().and_then(|v| v["error"]["message"].as_str().map(String::from)).unwrap_or_default();
            Err(match code {
                401 | 403 => "The API key was rejected. Check it in settings.".into(),
                429 => "Rate limited by the API. Wait a moment and try again.".into(),
                529 | 500..=599 => format!("The API is temporarily unavailable ({code}). Try again shortly."),
                _ => format!("API error {code}: {detail}"),
            })
        }
        Err(ureq::Error::Transport(t)) => Err(format!("Could not reach the API (offline?): {t}")),
    }
}

/// The JSON text of a structured-output response, after refusal and truncation checks.
fn output_text<'a>(body: &'a Value, what: &str) -> Result<&'a str, String> {
    if body["stop_reason"] == "refusal" {
        let category = body["stop_details"]["category"].as_str().unwrap_or("unspecified");
        return Err(format!("Claude declined to {what} (category: {category})."));
    }
    if body["stop_reason"] == "max_tokens" {
        return Err("The response was cut off before it finished. Try again.".into());
    }
    body["content"]
        .as_array()
        .and_then(|blocks| blocks.iter().find(|b| b["type"] == "text"))
        .and_then(|b| b["text"].as_str())
        .ok_or_else(|| "The response had no text block.".to_string())
}

pub fn request_critique(image_base64: &str, platform: &str, title: &str) -> Result<Critique, String> {
    if image_base64.len() > MAX_BASE64_LEN {
        return Err("Image is too large to send (5 MB limit).".into());
    }
    parse_response(&post(build_request(image_base64, platform, title))?)
}

// ---- Idea categorization (text only; screenshots are OCR'd locally first) ----

/// Bump when the categorization prompt or schema changes.
const CATEGORIZE_VERSION: u32 = 1;
/// Ideas are short; past this it's a pasted article and the start is enough to sort it.
const MAX_IDEA_CHARS: usize = 6000;

const CATEGORIZE_PROMPT: &str = "You sort content ideas for a solo video creator. The idea may be a typed note or text \
read by OCR from a screenshot (a post, a comment, a note), so ignore UI noise such as usernames, timestamps, like counts \
and buttons, and read past OCR typos.

Pick the one category from the creator's list that best fits the video this idea would become. Suggest a working title \
in plain words (under 70 characters, no emoji, no hashtags) that says what the video delivers. Give 3 to 5 short \
lowercase topic tags (one or two words each) that would help find this idea later.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub category: String,
    pub title: String,
    pub tags: Vec<String>,
    /// "ai" or "local"
    pub source: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub cached: bool,
    /// Why the offline (keyword) suggestion picked its category.
    #[serde(default)]
    pub reason: Option<String>,
}

pub fn build_categorize_request(text: &str, taxonomy: &[String]) -> Value {
    let text: String = text.trim().chars().take(MAX_IDEA_CHARS).collect();
    json!({
        "model": MODEL,
        "max_tokens": 4000,
        "system": CATEGORIZE_PROMPT,
        "output_config": {
            "effort": "low",
            "format": { "type": "json_schema", "schema": {
                "type": "object",
                "properties": {
                    "category": { "type": "string", "enum": taxonomy },
                    "title": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["category", "title", "tags"],
                "additionalProperties": false
            }}
        },
        "fallbacks": "default",
        "messages": [{ "role": "user", "content": format!("Categories: {}\n\n<idea>\n{text}\n</idea>", taxonomy.join(", ")) }]
    })
}

pub fn parse_categorize_response(body: &Value, taxonomy: &[String]) -> Result<Suggestion, String> {
    #[derive(Deserialize)]
    struct RawSuggestion {
        category: String,
        title: String,
        tags: Vec<String>,
    }
    let raw: RawSuggestion = serde_json::from_str(output_text(body, "categorize this idea")?).map_err(|e| format!("Unexpected response format: {e}"))?;
    let category = taxonomy
        .iter()
        .find(|c| c.eq_ignore_ascii_case(raw.category.trim()))
        .cloned()
        .ok_or_else(|| format!("Claude suggested \"{}\", which is not one of your categories.", raw.category))?;
    let mut tags: Vec<String> = Vec::new();
    for t in raw.tags.iter().map(|t| t.trim().trim_start_matches('#').to_lowercase()).filter(|t| !t.is_empty()) {
        if !tags.contains(&t) {
            tags.push(t);
        }
    }
    tags.truncate(5);
    Ok(Suggestion {
        category,
        title: raw.title.trim().chars().take(100).collect(),
        tags,
        source: "ai".into(),
        model: Some(body["model"].as_str().unwrap_or(MODEL).to_string()),
        cached: false,
        reason: None,
    })
}

fn categorize_cache_key(text: &str, taxonomy: &[String]) -> String {
    let mut h = blake3::Hasher::new();
    for part in [text.trim(), &taxonomy.join("\n"), MODEL, "categorize", &CATEGORIZE_VERSION.to_string()] {
        h.update(part.as_bytes());
        h.update(&[0]);
    }
    h.finalize().to_hex().to_string()
}

pub fn cached_suggestion(conn: &Connection, text: &str, taxonomy: &[String]) -> Option<Suggestion> {
    let json: Option<String> = conn
        .query_row("SELECT response FROM ai_cache WHERE cache_key = ?1", params![categorize_cache_key(text, taxonomy)], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    json.and_then(|j| serde_json::from_str::<Suggestion>(&j).ok()).map(|s| Suggestion { cached: true, ..s })
}

pub fn store_suggestion(conn: &Connection, text: &str, taxonomy: &[String], s: &Suggestion) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_cache (cache_key, response, created_at) VALUES (?1, ?2, ?3)",
        params![categorize_cache_key(text, taxonomy), serde_json::to_string(s).expect("serialize"), db::now()],
    )?;
    Ok(())
}

pub fn request_categorization(text: &str, taxonomy: &[String]) -> Result<Suggestion, String> {
    if text.trim().is_empty() {
        return Err("The idea has no text to categorize yet.".into());
    }
    if taxonomy.is_empty() {
        return Err("Add at least one category first.".into());
    }
    parse_categorize_response(&post(build_categorize_request(text, taxonomy))?, taxonomy)
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

    #[test]
    fn categorize_request_constrains_category_and_sends_text_only() {
        let tax = vec!["tutorial".to_string(), "talking-head".to_string()];
        let r = build_categorize_request("  3 squat mistakes  ", &tax);
        assert_eq!(r["output_config"]["format"]["schema"]["properties"]["category"]["enum"], json!(tax));
        let content = r["messages"][0]["content"].as_str().unwrap();
        assert!(content.contains("<idea>\n3 squat mistakes\n</idea>") && content.contains("tutorial, talking-head"));
        let long = "x".repeat(MAX_IDEA_CHARS + 500);
        assert!(build_categorize_request(&long, &tax)["messages"][0]["content"].as_str().unwrap().len() < MAX_IDEA_CHARS + 200);
    }

    #[test]
    fn categorize_parse_normalizes_and_rejects_unknown_categories() {
        let tax = vec!["tutorial".to_string(), "talking-head".to_string()];
        let body = |cat: &str| {
            let text = json!({ "category": cat, "title": " Fix your squat ", "tags": ["#Squat", "squat", "legs", "form", "gym", "mobility", "x"] }).to_string();
            json!({ "model": "claude-opus-5-5", "stop_reason": "end_turn", "content": [{ "type": "text", "text": text }] })
        };
        let s = parse_categorize_response(&body("Talking-Head"), &tax).unwrap();
        assert_eq!(s.category, "talking-head");
        assert_eq!(s.title, "Fix your squat");
        assert_eq!(s.tags, vec!["squat", "legs", "form", "gym", "mobility"]);
        assert!(parse_categorize_response(&body("vlog"), &tax).is_err());
        let refusal = json!({ "stop_reason": "refusal", "content": [] });
        assert!(parse_categorize_response(&refusal, &tax).unwrap_err().contains("declined"));
    }

    #[test]
    fn suggestion_cache_is_keyed_by_text_and_taxonomy() {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        let tax = vec!["a".to_string(), "b".to_string()];
        let s = Suggestion { category: "a".into(), title: "t".into(), tags: vec![], source: "ai".into(), model: None, cached: false, reason: None };
        store_suggestion(&c, "idea", &tax, &s).unwrap();
        assert!(cached_suggestion(&c, " idea ", &tax).unwrap().cached);
        assert!(cached_suggestion(&c, "idea", &["a".to_string()]).is_none());
    }
}
