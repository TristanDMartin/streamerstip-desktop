use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyMode {
    LocalFirst,
    CloudAssisted,
    CloudProject,
}

impl Default for PrivacyMode {
    fn default() -> Self {
        Self::LocalFirst
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelClass {
    ReasoningPremium,
    ReasoningStandard,
    FastText,
    VisionStandard,
    VisionPremium,
    Transcription,
    ImageGeneration,
    LocalFast,
    LocalPrivate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    NotConnected,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteError {
    CloudRefused,
    Provider(ProviderError),
}

pub trait ModelProvider {
    fn id(&self) -> &str;
    fn is_cloud(&self) -> bool;
    fn supports(&self, class: ModelClass) -> bool;
    fn generate_text(&self, prompt: &str) -> Result<String, ProviderError>;
    fn analyze_structured_data(&self, data: &Value) -> Result<Value, ProviderError>;
    fn analyze_image(&self, path: &str) -> Result<Value, ProviderError>;
}

#[derive(Debug, Default)]
pub struct LocalProvider;

impl ModelProvider for LocalProvider {
    fn id(&self) -> &str {
        "local"
    }

    fn is_cloud(&self) -> bool {
        false
    }

    fn supports(&self, class: ModelClass) -> bool {
        matches!(
            class,
            ModelClass::LocalFast | ModelClass::LocalPrivate | ModelClass::FastText
        )
    }

    fn generate_text(&self, _prompt: &str) -> Result<String, ProviderError> {
        Err(ProviderError::NotConnected)
    }

    fn analyze_structured_data(&self, _data: &Value) -> Result<Value, ProviderError> {
        Err(ProviderError::NotConnected)
    }

    fn analyze_image(&self, _path: &str) -> Result<Value, ProviderError> {
        Err(ProviderError::NotConnected)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CloudProvider {
    name: &'static str,
}

impl CloudProvider {
    pub const OPENAI: Self = Self { name: "openai" };
    pub const GOOGLE: Self = Self { name: "google" };
    pub const ANTHROPIC: Self = Self { name: "anthropic" };
}

impl ModelProvider for CloudProvider {
    fn id(&self) -> &str {
        self.name
    }

    fn is_cloud(&self) -> bool {
        true
    }

    fn supports(&self, class: ModelClass) -> bool {
        !matches!(class, ModelClass::LocalFast | ModelClass::LocalPrivate)
    }

    fn generate_text(&self, _prompt: &str) -> Result<String, ProviderError> {
        Err(ProviderError::NotConnected)
    }

    fn analyze_structured_data(&self, _data: &Value) -> Result<Value, ProviderError> {
        Err(ProviderError::NotConnected)
    }

    fn analyze_image(&self, _path: &str) -> Result<Value, ProviderError> {
        Err(ProviderError::NotConnected)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RouteRequest {
    pub class: ModelClass,
    pub privacy: PrivacyMode,
    pub prefer_cloud: bool,
    pub cloud_cost_is_lower: bool,
}

#[derive(Debug)]
pub struct ModelRouter {
    local: LocalProvider,
    openai: CloudProvider,
    google: CloudProvider,
    anthropic: CloudProvider,
}

impl ModelRouter {
    pub fn new() -> Self {
        Self {
            local: LocalProvider,
            openai: CloudProvider::OPENAI,
            google: CloudProvider::GOOGLE,
            anthropic: CloudProvider::ANTHROPIC,
        }
    }

    pub fn route(&self, request: &RouteRequest) -> Result<String, RouteError> {
        if request.privacy == PrivacyMode::LocalFirst {
            let cloud_would_win = request.prefer_cloud || request.cloud_cost_is_lower;
            if self.local.supports(request.class) {
                let _ignored = cloud_would_win;
                return Ok(self.local.id().to_string());
            }
            return Err(RouteError::CloudRefused);
        }
        if request.prefer_cloud || !self.local.supports(request.class) {
            return Ok(self.openai.id().to_string());
        }
        Ok(self.local.id().to_string())
    }

    fn provider(&self, id: &str) -> &dyn ModelProvider {
        match id {
            "google" => &self.google,
            "anthropic" => &self.anthropic,
            "openai" => &self.openai,
            _ => &self.local,
        }
    }

    pub fn dispatch(&self, request: &RouteRequest, prompt: &str) -> Result<String, RouteError> {
        let provider_id = self.route(request)?;
        let provider = self.provider(&provider_id);
        if request.privacy == PrivacyMode::LocalFirst && provider.is_cloud() {
            return Err(RouteError::CloudRefused);
        }
        provider.generate_text(prompt).map_err(RouteError::Provider)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TippyReply {
    pub connected: bool,
    pub message: String,
}

pub fn submit_tippy_message(text: &str) -> TippyReply {
    let _trimmed = text.trim();
    TippyReply {
        connected: false,
        message: "Tippy is not connected yet.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(class: ModelClass, privacy: PrivacyMode) -> RouteRequest {
        RouteRequest {
            class,
            privacy,
            prefer_cloud: true,
            cloud_cost_is_lower: true,
        }
    }

    #[test]
    fn local_only_refuses_cloud_even_when_cloud_is_cheaper() {
        let router = ModelRouter::new();
        let err = router
            .route(&request(
                ModelClass::ReasoningPremium,
                PrivacyMode::LocalFirst,
            ))
            .unwrap_err();
        assert_eq!(err, RouteError::CloudRefused);
    }

    #[test]
    fn local_only_keeps_a_local_class_on_the_local_provider() {
        let router = ModelRouter::new();
        let id = router
            .route(&request(ModelClass::LocalFast, PrivacyMode::LocalFirst))
            .unwrap();
        assert_eq!(id, "local");
        let err = router
            .dispatch(
                &request(ModelClass::LocalPrivate, PrivacyMode::LocalFirst),
                "hello",
            )
            .unwrap_err();
        assert_eq!(err, RouteError::Provider(ProviderError::NotConnected));
    }

    #[test]
    fn cloud_providers_do_not_perform_a_model_call() {
        let provider = CloudProvider::ANTHROPIC;
        assert!(provider.is_cloud());
        assert_eq!(
            provider.generate_text("ping"),
            Err(ProviderError::NotConnected)
        );
        assert_eq!(
            provider.analyze_image("/tmp/frame.png"),
            Err(ProviderError::NotConnected)
        );
    }

    #[test]
    fn composer_does_not_route_a_model() {
        let reply = submit_tippy_message("Find my best clips");
        assert!(!reply.connected);
        assert_eq!(reply.message, "Tippy is not connected yet.");
    }
}
