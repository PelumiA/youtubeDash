//! AI calls: the thumbnail hook critique (vision) and idea categorization (text only).
//!
//! Two providers, chosen in Settings: Anthropic's Messages API (default) or OpenRouter's chat
//! completions API. Requests are built once in Messages form and translated for OpenRouter.
//! Raw HTTP (there is no official Rust SDK). Keys come from an environment variable or the OS
//! credential store and never reach the webview. Results are cached per provider + model (and
//! image + platform + title, or idea text + taxonomy), so asking again costs nothing.

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

const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
/// Claude Opus 5.5 on OpenRouter; any model there that takes images and structured output works.
pub const OPENROUTER_DEFAULT_MODEL: &str = "anthropic/claude-opus-5.5";
/// The answers are short JSON; a lower cap keeps OpenRouter's credit check small.
const OPENROUTER_MAX_TOKENS: u64 = 4000;

pub const PROVIDER_SETTING: &str = "ai.provider";
pub const OPENROUTER_MODEL_SETTING: &str = "ai.openrouterModel";

/// Bump when the prompt or schema changes so cached critiques are not reused.
const PROMPT_VERSION: u32 = 1;
const KEYRING_SERVICE: &str = "creator-dashboard";
/// The API accepts images up to 5 MB; base64 adds a third.
const MAX_BASE64_LEN: usize = 5 * 1024 * 1024 * 4 / 3;

// ---- Providers and keys ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Anthropic,
    OpenRouter,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::Anthropic, Provider::OpenRouter];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic",
            Provider::OpenRouter => "openrouter",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::Anthropic => "Anthropic API",
            Provider::OpenRouter => "OpenRouter",
        }
    }

    pub fn parse(id: &str) -> Result<Provider, String> {
        Provider::ALL.into_iter().find(|p| p.id() == id).ok_or_else(|| format!("Unknown AI provider {id}."))
    }

    fn env_var(self) -> &'static str {
        match self {
            Provider::Anthropic => "ANTHROPIC_API_KEY",
            Provider::OpenRouter => "OPENROUTER_API_KEY",
        }
    }

    fn keyring_user(self) -> &'static str {
        match self {
            Provider::Anthropic => "anthropic-api-key",
            Provider::OpenRouter => "openrouter-api-key",
        }
    }
}

/// The provider and model in use, from Settings.
#[derive(Debug, Clone, PartialEq)]
pub struct AiConfig {
    pub provider: Provider,
    pub model: String,
}

impl AiConfig {
    pub fn anthropic() -> AiConfig {
        AiConfig { provider: Provider::Anthropic, model: MODEL.into() }
    }

    /// Part of every cache key. Anthropic keeps the bare model id so earlier caches stay valid.
    fn cache_tag(&self) -> String {
        match self.provider {
            Provider::Anthropic => self.model.clone(),
            Provider::OpenRouter => format!("openrouter:{}", self.model),
        }
    }
}

pub fn valid_openrouter_model(model: &str) -> bool {
    let m = model.trim();
    m.len() <= 200 && m.split_once('/').is_some_and(|(org, name)| !org.is_empty() && !name.is_empty()) && !m.chars().any(char::is_whitespace)
}

pub fn config(conn: &Connection) -> AiConfig {
    let setting = |key: &str| conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get::<_, String>(0)).optional().ok().flatten();
    match setting(PROVIDER_SETTING).as_deref() {
        Some("openrouter") => {
            let model = setting(OPENROUTER_MODEL_SETTING).filter(|m| valid_openrouter_model(m)).unwrap_or_else(|| OPENROUTER_DEFAULT_MODEL.into());
            AiConfig { provider: Provider::OpenRouter, model: model.trim().to_string() }
        }
        _ => AiConfig::anthropic(),
    }
}

fn keyring_entry(p: Provider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, p.keyring_user()).map_err(|e| e.to_string())
}

fn api_key(p: Provider) -> Option<(String, &'static str)> {
    if let Ok(k) = std::env::var(p.env_var()) {
        if !k.trim().is_empty() {
            return Some((k.trim().to_string(), "env"));
        }
    }
    keyring_entry(p).ok()?.get_password().ok().map(|k| (k, "keychain"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    pub configured: bool,
    /// "env" or "keychain"
    pub source: Option<String>,
    /// Environment variable that overrides the stored key.
    pub env_var: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// The provider in use.
    pub provider: String,
    pub provider_label: String,
    /// Whether the provider in use has a key.
    pub configured: bool,
    pub source: Option<String>,
    pub model: String,
    pub providers: Vec<ProviderStatus>,
}

pub fn status(conn: &Connection) -> AiStatus {
    let cfg = config(conn);
    let providers: Vec<ProviderStatus> = Provider::ALL
        .into_iter()
        .map(|p| {
            let source = api_key(p).map(|(_, s)| s.to_string());
            ProviderStatus { id: p.id().into(), label: p.label().into(), configured: source.is_some(), source, env_var: p.env_var().into() }
        })
        .collect();
    let current = providers.iter().find(|p| p.id == cfg.provider.id()).expect("listed").clone();
    AiStatus {
        provider: current.id,
        provider_label: current.label,
        configured: current.configured,
        source: current.source,
        model: cfg.model,
        providers,
    }
}

pub fn set_key(p: Provider, key: &str) -> Result<(), String> {
    let key = key.trim();
    let ok = match p {
        Provider::Anthropic => key.starts_with("sk-ant-") && key.len() >= 20,
        Provider::OpenRouter => key.len() >= 20 && !key.chars().any(char::is_whitespace),
    };
    if !ok {
        return Err(match p {
            Provider::Anthropic => "That doesn't look like an Anthropic API key (they start with sk-ant-).".into(),
            Provider::OpenRouter => "That doesn't look like an OpenRouter API key.".into(),
        });
    }
    keyring_entry(p)?.set_password(key).map_err(|e| format!("Could not save to the system keychain: {e}"))
}

pub fn clear_key(p: Provider) -> Result<(), String> {
    match keyring_entry(p)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- Transport -------------------------------------------------------------------------

/// Sends a Messages-form request with the configured provider. Returns the structured-output
/// JSON text and the model that answered. Blocking; run off the main thread.
fn complete(cfg: &AiConfig, body: Value, what: &str) -> Result<(String, String), String> {
    let (key, _) = api_key(cfg.provider).ok_or_else(|| format!("No {} key set. Add one in Settings to use the AI features.", cfg.provider.label()))?;
    match cfg.provider {
        Provider::Anthropic => {
            let resp = post_anthropic(&key, body)?;
            let text = output_text(&resp, what)?.to_string();
            Ok((text, resp["model"].as_str().unwrap_or(MODEL).to_string()))
        }
        Provider::OpenRouter => openrouter_text(&post_openrouter(&key, to_openrouter(&body, &cfg.model))?, what),
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(180)).build()
}

fn post_anthropic(key: &str, body: Value) -> Result<Value, String> {
    let resp = agent()
        .post(API_URL)
        .set("x-api-key", key)
        .set("anthropic-version", API_VERSION)
        .set("anthropic-beta", FALLBACK_BETA)
        .set("content-type", "application/json")
        .send_json(body);
    match resp {
        Ok(r) => r.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_json::<Value>().ok().and_then(|v| v["error"]["message"].as_str().map(String::from)).unwrap_or_default();
            Err(match code {
                401 | 403 => "The Anthropic API key was rejected. Check it in Settings.".into(),
                429 => "Rate limited by the API. Wait a moment and try again.".into(),
                529 | 500..=599 => format!("The API is temporarily unavailable ({code}). Try again shortly."),
                _ => format!("API error {code}: {detail}"),
            })
        }
        Err(ureq::Error::Transport(t)) => Err(format!("Could not reach the API (offline?): {t}")),
    }
}

fn post_openrouter(key: &str, body: Value) -> Result<Value, String> {
    let resp = agent()
        .post(OPENROUTER_URL)
        .set("authorization", &format!("Bearer {key}"))
        .set("x-title", "Creator Dashboard")
        .set("content-type", "application/json")
        .send_json(body);
    match resp {
        Ok(r) => r.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let detail = r.into_json::<Value>().ok().and_then(|v| v["error"]["message"].as_str().map(String::from)).unwrap_or_default();
            Err(openrouter_error(code, &detail))
        }
        Err(ureq::Error::Transport(t)) => Err(format!("Could not reach OpenRouter (offline?): {t}")),
    }
}

fn openrouter_error(code: u16, detail: &str) -> String {
    match code {
        401 => "The OpenRouter key was rejected. Check it in Settings.".into(),
        402 => "Your OpenRouter account is out of credits. Add credits on openrouter.ai and try again.".into(),
        403 => format!("OpenRouter blocked the request (moderation or a guardrail): {detail}"),
        408 => "OpenRouter timed out. Try again.".into(),
        429 => "Rate limited by OpenRouter. Wait a moment and try again.".into(),
        502 => "The model is down on OpenRouter right now. Try again shortly, or pick another model in Settings.".into(),
        503 => "No OpenRouter provider can serve this model with structured output and without keeping your data. Pick another model in Settings.".into(),
        _ => format!("OpenRouter error {code}: {detail}"),
    }
}

/// Messages-form request → OpenRouter chat completion. Images become base64 data URLs, the
/// output schema becomes a strict `response_format`, and routing is limited to providers that
/// support every parameter and don't collect prompts.
pub fn to_openrouter(body: &Value, model: &str) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": body["system"] })];
    for m in body["messages"].as_array().into_iter().flatten() {
        let content = match &m["content"] {
            Value::Array(blocks) => Value::Array(
                blocks
                    .iter()
                    .map(|b| match b["type"].as_str() {
                        Some("image") => json!({
                            "type": "image_url",
                            "image_url": { "url": format!("data:{};base64,{}", b["source"]["media_type"].as_str().unwrap_or("image/jpeg"), b["source"]["data"].as_str().unwrap_or("")) }
                        }),
                        _ => json!({ "type": "text", "text": b["text"] }),
                    })
                    .collect(),
            ),
            other => other.clone(),
        };
        messages.push(json!({ "role": m["role"], "content": content }));
    }
    json!({
        "model": model,
        "max_tokens": body["max_tokens"].as_u64().unwrap_or(OPENROUTER_MAX_TOKENS).min(OPENROUTER_MAX_TOKENS),
        "messages": messages,
        "response_format": { "type": "json_schema", "json_schema": { "name": "result", "strict": true, "schema": body["output_config"]["format"]["schema"] } },
        "provider": { "require_parameters": true, "data_collection": "deny" }
    })
}

/// The JSON text of an OpenRouter response, after error, refusal and truncation checks.
pub fn openrouter_text(body: &Value, what: &str) -> Result<(String, String), String> {
    if let Some(msg) = body["error"]["message"].as_str() {
        return Err(format!("OpenRouter error: {msg}"));
    }
    let choice = &body["choices"][0];
    if let Some(msg) = choice["error"]["message"].as_str() {
        return Err(format!("The model failed: {msg}"));
    }
    match choice["finish_reason"].as_str() {
        Some("length") => return Err("The response was cut off before it finished. Try again.".into()),
        Some("content_filter") => return Err(format!("The model declined to {what} (content filter).")),
        _ => {}
    }
    if let Some(r) = choice["message"]["refusal"].as_str().filter(|r| !r.trim().is_empty()) {
        return Err(format!("The model declined to {what}: {r}"));
    }
    let content = &choice["message"]["content"];
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(""),
        _ => String::new(),
    };
    let text = strip_code_fence(&text);
    if text.is_empty() {
        return Err("The response had no text.".into());
    }
    Ok((text, body["model"].as_str().unwrap_or("unknown model").to_string()))
}

/// Some models wrap JSON in a ```json fence even when asked for structured output.
fn strip_code_fence(text: &str) -> String {
    let t = text.trim();
    match t.strip_prefix("```") {
        Some(rest) => rest.split_once('\n').map(|(_, body)| body).unwrap_or("").trim_end().trim_end_matches("```").trim().to_string(),
        None => t.to_string(),
    }
}

/// The JSON text of a Messages structured-output response, after refusal and truncation checks.
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

fn cache_key(parts: &[&str]) -> String {
    let mut h = blake3::Hasher::new();
    for part in parts {
        h.update(part.as_bytes());
        h.update(&[0]);
    }
    h.finalize().to_hex().to_string()
}

fn cache_get<T: for<'de> Deserialize<'de>>(conn: &Connection, key: &str) -> Option<T> {
    let json: Option<String> = conn.query_row("SELECT response FROM ai_cache WHERE cache_key = ?1", params![key], |r| r.get(0)).optional().ok().flatten();
    json.and_then(|j| serde_json::from_str(&j).ok())
}

fn cache_put<T: Serialize>(conn: &Connection, key: &str, value: &T) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_cache (cache_key, response, created_at) VALUES (?1, ?2, ?3)",
        params![key, serde_json::to_string(value).expect("serialize"), db::now()],
    )?;
    Ok(())
}

// ---- Thumbnail hook critique -----------------------------------------------------------

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

/// Parses the structured-output JSON of a critique.
pub fn parse_critique(text: &str, model: &str) -> Result<Critique, String> {
    #[derive(Deserialize)]
    struct Raw {
        hook_score: f64,
        reads_in_one_second: bool,
        emotion: String,
        story: String,
        subject_note: String,
        critique: Vec<String>,
    }
    let raw: Raw = serde_json::from_str(text).map_err(|e| format!("Unexpected response format: {e}"))?;
    Ok(Critique {
        model: model.to_string(),
        hook_score: raw.hook_score.clamp(0.0, 10.0),
        reads_in_one_second: raw.reads_in_one_second,
        emotion: raw.emotion,
        story: raw.story,
        subject_note: raw.subject_note,
        critique: raw.critique.into_iter().take(5).collect(),
        cached: false,
    })
}

fn critique_key(cfg: &AiConfig, file_hash: &str, platform: &str, title: &str) -> String {
    cache_key(&[file_hash, platform, title.trim(), &cfg.cache_tag(), &PROMPT_VERSION.to_string()])
}

pub fn cached(conn: &Connection, cfg: &AiConfig, file_hash: &str, platform: &str, title: &str) -> Option<Critique> {
    cache_get::<Critique>(conn, &critique_key(cfg, file_hash, platform, title)).map(|c| Critique { cached: true, ..c })
}

pub fn store(conn: &Connection, cfg: &AiConfig, file_hash: &str, platform: &str, title: &str, c: &Critique) -> rusqlite::Result<()> {
    cache_put(conn, &critique_key(cfg, file_hash, platform, title), c)
}

pub fn request_critique(cfg: &AiConfig, image_base64: &str, platform: &str, title: &str) -> Result<Critique, String> {
    if image_base64.len() > MAX_BASE64_LEN {
        return Err("Image is too large to send (5 MB limit).".into());
    }
    let (text, model) = complete(cfg, build_request(image_base64, platform, title), "critique this image")?;
    parse_critique(&text, &model)
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

pub fn parse_suggestion(text: &str, model: &str, taxonomy: &[String]) -> Result<Suggestion, String> {
    #[derive(Deserialize)]
    struct RawSuggestion {
        category: String,
        title: String,
        tags: Vec<String>,
    }
    let raw: RawSuggestion = serde_json::from_str(text).map_err(|e| format!("Unexpected response format: {e}"))?;
    let category = taxonomy
        .iter()
        .find(|c| c.eq_ignore_ascii_case(raw.category.trim()))
        .cloned()
        .ok_or_else(|| format!("The model suggested \"{}\", which is not one of your categories.", raw.category))?;
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
        model: Some(model.to_string()),
        cached: false,
        reason: None,
    })
}

fn suggestion_key(cfg: &AiConfig, text: &str, taxonomy: &[String]) -> String {
    cache_key(&[text.trim(), &taxonomy.join("\n"), &cfg.cache_tag(), "categorize", &CATEGORIZE_VERSION.to_string()])
}

pub fn cached_suggestion(conn: &Connection, cfg: &AiConfig, text: &str, taxonomy: &[String]) -> Option<Suggestion> {
    cache_get::<Suggestion>(conn, &suggestion_key(cfg, text, taxonomy)).map(|s| Suggestion { cached: true, ..s })
}

pub fn store_suggestion(conn: &Connection, cfg: &AiConfig, text: &str, taxonomy: &[String], s: &Suggestion) -> rusqlite::Result<()> {
    cache_put(conn, &suggestion_key(cfg, text, taxonomy), s)
}

pub fn request_categorization(cfg: &AiConfig, text: &str, taxonomy: &[String]) -> Result<Suggestion, String> {
    if text.trim().is_empty() {
        return Err("The idea has no text to categorize yet.".into());
    }
    if taxonomy.is_empty() {
        return Err("Add at least one category first.".into());
    }
    let (out, model) = complete(cfg, build_categorize_request(text, taxonomy), "categorize this idea")?;
    parse_suggestion(&out, &model, taxonomy)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        db::migrate(&c).unwrap();
        c
    }

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
    fn messages_text_handles_success_refusal_and_truncation() {
        let ok = json!({ "model": "claude-opus-5-5", "stop_reason": "end_turn", "content": [{ "type": "thinking", "thinking": "" }, { "type": "text", "text": "{}" }] });
        assert_eq!(output_text(&ok, "x").unwrap(), "{}");
        let refusal = json!({ "stop_reason": "refusal", "stop_details": { "category": "cyber" }, "content": [] });
        assert!(output_text(&refusal, "x").unwrap_err().contains("declined"));
        assert!(output_text(&json!({ "stop_reason": "max_tokens", "content": [] }), "x").is_err());
    }

    #[test]
    fn critique_parse_clamps_and_caps() {
        let text = r#"{"hook_score": 12, "reads_in_one_second": true, "emotion": "surprise", "story": "A fix for leg day.", "subject_note": "Clear face.", "critique": ["a","b","c","d","e","f"]}"#;
        let c = parse_critique(text, "claude-opus-5-5").unwrap();
        assert_eq!(c.hook_score, 10.0, "clamped");
        assert_eq!(c.critique.len(), 5, "capped");
        assert!(parse_critique("not json", "m").is_err());
    }

    #[test]
    fn caches_are_keyed_by_provider_and_model() {
        let c = conn();
        let anthropic = AiConfig::anthropic();
        let router = AiConfig { provider: Provider::OpenRouter, model: OPENROUTER_DEFAULT_MODEL.into() };
        let crit = Critique { model: MODEL.into(), hook_score: 7.0, reads_in_one_second: true, emotion: "e".into(), story: "s".into(), subject_note: "n".into(), critique: vec![], cached: false };
        store(&c, &anthropic, "fp:1", "youtube", "Title", &crit).unwrap();
        assert!(cached(&c, &anthropic, "fp:1", "youtube", "Title").unwrap().cached);
        assert!(cached(&c, &anthropic, "fp:1", "youtube", "Other title").is_none());
        assert!(cached(&c, &anthropic, "fp:1", "instagram", "Title").is_none());
        assert!(cached(&c, &router, "fp:1", "youtube", "Title").is_none(), "another provider asks again");
        // Anthropic keys match the pre-OpenRouter format, so existing caches stay valid.
        assert_eq!(critique_key(&anthropic, "fp:1", "youtube", "Title"), cache_key(&["fp:1", "youtube", "Title", MODEL, "1"]));
    }

    #[test]
    fn config_reads_provider_and_validates_model() {
        let c = conn();
        assert_eq!(config(&c), AiConfig::anthropic());
        c.execute("INSERT INTO settings (key, value) VALUES (?1, 'openrouter')", params![PROVIDER_SETTING]).unwrap();
        assert_eq!(config(&c).model, OPENROUTER_DEFAULT_MODEL);
        c.execute("INSERT INTO settings (key, value) VALUES (?1, ' google/gemini-x ')", params![OPENROUTER_MODEL_SETTING]).unwrap();
        assert_eq!(config(&c), AiConfig { provider: Provider::OpenRouter, model: "google/gemini-x".into() });
        c.execute("UPDATE settings SET value = 'no slash' WHERE key = ?1", params![OPENROUTER_MODEL_SETTING]).unwrap();
        assert_eq!(config(&c).model, OPENROUTER_DEFAULT_MODEL, "invalid model falls back");
        assert!(Provider::parse("openai").is_err());
    }

    #[test]
    fn openrouter_request_translates_image_schema_and_privacy() {
        let r = to_openrouter(&build_request("QUJD", "youtube", "T"), "anthropic/claude-opus-5.5");
        assert_eq!(r["model"], "anthropic/claude-opus-5.5");
        assert_eq!(r["max_tokens"], OPENROUTER_MAX_TOKENS);
        assert_eq!(r["messages"][0]["role"], "system");
        assert!(r["messages"][0]["content"].as_str().unwrap().starts_with("You review video thumbnails"));
        assert_eq!(r["messages"][1]["content"][0], json!({ "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,QUJD" } }));
        assert_eq!(r["messages"][1]["content"][1]["type"], "text");
        assert_eq!(r["response_format"]["type"], "json_schema");
        assert_eq!(r["response_format"]["json_schema"]["strict"], true);
        assert_eq!(r["response_format"]["json_schema"]["schema"], schema());
        assert_eq!(r["provider"], json!({ "require_parameters": true, "data_collection": "deny" }));
        assert!(r.get("output_config").is_none() && r.get("fallbacks").is_none() && r.get("system").is_none());

        let tax = vec!["a".to_string()];
        let text_only = to_openrouter(&build_categorize_request("idea", &tax), "x/y");
        assert!(text_only["messages"][1]["content"].as_str().unwrap().contains("<idea>"));
        assert_eq!(text_only["response_format"]["json_schema"]["schema"]["properties"]["category"]["enum"], json!(tax));
    }

    #[test]
    fn openrouter_response_handling() {
        let ok = |content: Value, finish: &str| json!({ "model": "anthropic/claude-opus-5.5", "choices": [{ "finish_reason": finish, "message": { "role": "assistant", "content": content } }] });
        assert_eq!(openrouter_text(&ok(json!("{\"a\":1}"), "stop"), "x").unwrap(), ("{\"a\":1}".to_string(), "anthropic/claude-opus-5.5".to_string()));
        assert_eq!(openrouter_text(&ok(json!("```json\n{\"a\":1}\n```"), "stop"), "x").unwrap().0, "{\"a\":1}");
        assert_eq!(openrouter_text(&ok(json!([{ "type": "text", "text": "{}" }]), "stop"), "x").unwrap().0, "{}");
        assert!(openrouter_text(&ok(json!("{"), "length"), "x").unwrap_err().contains("cut off"));
        assert!(openrouter_text(&ok(json!(""), "content_filter"), "x").unwrap_err().contains("declined"));
        assert!(openrouter_text(&ok(json!(""), "stop"), "x").is_err());
        let refusal = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": null, "refusal": "I can't help with that." } }] });
        assert!(openrouter_text(&refusal, "x").unwrap_err().contains("can't help"));
        let mid_error = json!({ "choices": [{ "error": { "code": 502, "message": "upstream died" } }] });
        assert!(openrouter_text(&mid_error, "x").unwrap_err().contains("upstream died"));
        assert!(openrouter_error(402, "").contains("credits"));
        assert!(openrouter_error(503, "").contains("another model"));
    }

    #[test]
    fn keys_are_validated_per_provider() {
        assert!(set_key(Provider::Anthropic, "sk-or-v1-0000000000000000").is_err());
        assert!(set_key(Provider::OpenRouter, "short").is_err());
        assert!(set_key(Provider::OpenRouter, "has spaces in the middle of it").is_err());
        assert!(valid_openrouter_model("anthropic/claude-opus-5.5"));
        assert!(!valid_openrouter_model("claude"));
        assert!(!valid_openrouter_model("/x"));
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
    fn suggestion_parse_normalizes_and_rejects_unknown_categories() {
        let tax = vec!["tutorial".to_string(), "talking-head".to_string()];
        let text = |cat: &str| json!({ "category": cat, "title": " Fix your squat ", "tags": ["#Squat", "squat", "legs", "form", "gym", "mobility", "x"] }).to_string();
        let s = parse_suggestion(&text("Talking-Head"), "m", &tax).unwrap();
        assert_eq!(s.category, "talking-head");
        assert_eq!(s.title, "Fix your squat");
        assert_eq!(s.tags, vec!["squat", "legs", "form", "gym", "mobility"]);
        assert_eq!(s.model.as_deref(), Some("m"));
        assert!(parse_suggestion(&text("vlog"), "m", &tax).is_err());
    }

    #[test]
    fn suggestion_cache_is_keyed_by_text_taxonomy_and_provider() {
        let c = conn();
        let cfg = AiConfig::anthropic();
        let tax = vec!["a".to_string(), "b".to_string()];
        let s = Suggestion { category: "a".into(), title: "t".into(), tags: vec![], source: "ai".into(), model: None, cached: false, reason: None };
        store_suggestion(&c, &cfg, "idea", &tax, &s).unwrap();
        assert!(cached_suggestion(&c, &cfg, " idea ", &tax).unwrap().cached);
        assert!(cached_suggestion(&c, &cfg, "idea", &["a".to_string()]).is_none());
        assert!(cached_suggestion(&c, &AiConfig { provider: Provider::OpenRouter, model: "x/y".into() }, "idea", &tax).is_none());
    }
}
