use anyhow::Result;
use sqlx::SqlitePool;

use super::models::Participant;

pub async fn get_participants(pool: &SqlitePool, meeting_id: &str) -> Result<Vec<Participant>> {
    let rows = sqlx::query_as::<_, Participant>(
        "SELECT id, meeting_id, name FROM participants WHERE meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
