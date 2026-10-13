use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CostClass {
    FreeLocal,
    Cheap,
    Standard,
    Premium,
    Gpu,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub input_schema: &'static str,
    pub output_schema: &'static str,
    pub permissions: &'static str,
    pub cost_class: CostClass,
    pub local_capable: bool,
    pub cloud_capable: bool,
    pub requires_approval: bool,
    pub undo_strategy: &'static str,
}

const ACTIONS: &[ActionDefinition] = &[
    action(
        "probe_media",
        "Probe media",
        "{\"type\":\"object\",\"required\":[\"mediaId\"]}",
        "{\"type\":\"object\",\"required\":[\"probe\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "none",
    ),
    action(
        "create_proxy",
        "Create proxy",
        "{\"type\":\"object\",\"required\":[\"mediaId\"]}",
        "{\"type\":\"object\",\"required\":[\"proxyPath\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "delete_derived_file",
    ),
    action(
        "extract_audio",
        "Extract audio",
        "{\"type\":\"object\",\"required\":[\"mediaId\"]}",
        "{\"type\":\"object\",\"required\":[\"audioPath\",\"waveform\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "delete_derived_file",
    ),
    action(
        "trim_clip",
        "Trim clip",
        "{\"type\":\"object\",\"required\":[\"sourceId\",\"startMs\",\"endMs\"]}",
        "{\"type\":\"object\",\"required\":[\"outputPath\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "restore_previous_version",
    ),
    action(
        "split_clip",
        "Split clip",
        "{\"type\":\"object\",\"required\":[\"sourceId\",\"atMs\"]}",
        "{\"type\":\"object\",\"required\":[\"leftId\",\"rightId\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "restore_previous_version",
    ),
    action(
        "create_sequence",
        "Create sequence",
        "{\"type\":\"object\",\"required\":[\"name\"]}",
        "{\"type\":\"object\",\"required\":[\"sequenceId\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "delete_sequence",
    ),
    action(
        "remove_silence",
        "Remove silence",
        "{\"type\":\"object\",\"required\":[\"sequenceId\"]}",
        "{\"type\":\"object\",\"required\":[\"sequenceId\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "restore_previous_version",
    ),
    action(
        "add_caption_track",
        "Add caption track",
        "{\"type\":\"object\",\"required\":[\"sequenceId\"]}",
        "{\"type\":\"object\",\"required\":[\"trackId\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "delete_track",
    ),
    action(
        "update_caption",
        "Update caption",
        "{\"type\":\"object\",\"required\":[\"captionId\",\"text\"]}",
        "{\"type\":\"object\",\"required\":[\"captionId\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "restore_previous_version",
    ),
    action(
        "create_vertical_version",
        "Create vertical version",
        "{\"type\":\"object\",\"required\":[\"sourceId\",\"aspectRatio\"]}",
        "{\"type\":\"object\",\"required\":[\"mediaId\"]}",
        "project_owner",
        CostClass::Standard,
        true,
        false,
        true,
        "delete_derived_file",
    ),
    action(
        "reframe_subject",
        "Reframe subject",
        "{\"type\":\"object\",\"required\":[\"sourceId\"]}",
        "{\"type\":\"object\",\"required\":[\"mediaId\"]}",
        "project_owner",
        CostClass::Premium,
        false,
        true,
        true,
        "delete_derived_file",
    ),
    action(
        "normalize_audio",
        "Normalize audio",
        "{\"type\":\"object\",\"required\":[\"sourceId\"]}",
        "{\"type\":\"object\",\"required\":[\"outputPath\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "delete_derived_file",
    ),
    action(
        "render_sequence",
        "Render sequence",
        "{\"type\":\"object\",\"required\":[\"sequenceId\"]}",
        "{\"type\":\"object\",\"required\":[\"outputPath\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "delete_derived_file",
    ),
    action(
        "create_thumbnail",
        "Create thumbnail",
        "{\"type\":\"object\",\"required\":[\"mediaId\"]}",
        "{\"type\":\"object\",\"required\":[\"thumbnailPath\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "delete_derived_file",
    ),
    action(
        "create_export",
        "Create export",
        "{\"type\":\"object\",\"required\":[\"mediaId\"]}",
        "{\"type\":\"object\",\"required\":[\"exportId\"]}",
        "project_owner",
        CostClass::FreeLocal,
        true,
        false,
        false,
        "delete_derived_file",
    ),
    action(
        "create_title_options",
        "Create title options",
        "{\"type\":\"object\",\"required\":[\"projectId\"]}",
        "{\"type\":\"object\",\"required\":[\"titles\"]}",
        "project_owner",
        CostClass::Cheap,
        false,
        true,
        true,
        "discard_suggestions",
    ),
    action(
        "create_description",
        "Create description",
        "{\"type\":\"object\",\"required\":[\"projectId\"]}",
        "{\"type\":\"object\",\"required\":[\"description\"]}",
        "project_owner",
        CostClass::Cheap,
        false,
        true,
        true,
        "discard_suggestions",
    ),
    action(
        "create_content_plan",
        "Create content plan",
        "{\"type\":\"object\",\"required\":[\"projectId\"]}",
        "{\"type\":\"object\",\"required\":[\"plan\"]}",
        "project_owner",
        CostClass::Standard,
        false,
        true,
        true,
        "discard_suggestions",
    ),
];

const fn action(
    id: &'static str,
    name: &'static str,
    input_schema: &'static str,
    output_schema: &'static str,
    permissions: &'static str,
    cost_class: CostClass,
    local_capable: bool,
    cloud_capable: bool,
    requires_approval: bool,
    undo_strategy: &'static str,
) -> ActionDefinition {
    ActionDefinition {
        id,
        name,
        input_schema,
        output_schema,
        permissions,
        cost_class,
        local_capable,
        cloud_capable,
        requires_approval,
        undo_strategy,
    }
}

pub fn registry() -> &'static [ActionDefinition] {
    ACTIONS
}

pub fn find(id: &str) -> Option<&'static ActionDefinition> {
    ACTIONS.iter().find(|action| action.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_the_specified_actions() {
        let required = [
            "trim_clip",
            "split_clip",
            "create_sequence",
            "remove_silence",
            "add_caption_track",
            "update_caption",
            "create_vertical_version",
            "reframe_subject",
            "normalize_audio",
            "create_export",
            "create_thumbnail",
            "create_title_options",
            "create_description",
            "create_content_plan",
        ];
        for id in required {
            let action = find(id).unwrap_or_else(|| panic!("missing {id}"));
            assert!(!action.name.is_empty());
            assert!(action.input_schema.starts_with('{'));
            assert!(action.output_schema.starts_with('{'));
            assert!(!action.permissions.is_empty());
            assert!(!action.undo_strategy.is_empty());
        }
    }
}
