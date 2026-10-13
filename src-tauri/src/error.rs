use thiserror::Error;

#[derive(Debug, Error)]
pub enum DesktopError {
    #[error(
        "this project uses schema version {found}, which is newer than this app ({supported}). It was not opened or modified."
    )]
    NewerThanApp { found: u32, supported: u32 },
    #[error("the project file is damaged and no autosave snapshot could be recovered")]
    Unrecoverable,
    #[error("no migration step from schema version {from}")]
    NoMigration { from: u32 },
    #[error("project file is not valid JSON")]
    Corrupt,
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type DesktopResult<T> = Result<T, DesktopError>;
