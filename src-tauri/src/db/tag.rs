use crate::db::models::Tag;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

pub async fn get_tags(pool: &SqlitePool) -> Result<Vec<Tag>, sqlx::Error> {
    let rows =
        sqlx::query_as::<_, Tag>("SELECT id, name, color, created_at FROM tags ORDER BY name ASC")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

pub async fn create_tag(pool: &SqlitePool, name: &str, color: &str) -> Result<Tag, sqlx::Error> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(name)
        .bind(color)
        .bind(&now)
        .execute(pool)
        .await?;
    Ok(Tag {
        id,
        name: name.to_string(),
        color: color.to_string(),
        created_at: now,
    })
}

pub async fn delete_tag(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM tags WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_meeting_tags(
    pool: &SqlitePool,
    meeting_id: &str,
    tag_ids: &[String],
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM meeting_tags WHERE meeting_id = ?")
        .bind(meeting_id)
        .execute(pool)
        .await?;
    for tag_id in tag_ids {
        sqlx::query("INSERT OR IGNORE INTO meeting_tags (meeting_id, tag_id) VALUES (?, ?)")
            .bind(meeting_id)
            .bind(tag_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn get_meeting_tags(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<Vec<Tag>, sqlx::Error> {
    let rows = sqlx::query_as::<_, Tag>(
        "SELECT t.id, t.name, t.color, t.created_at
         FROM tags t
         INNER JOIN meeting_tags mt ON mt.tag_id = t.id
         WHERE mt.meeting_id = ?
         ORDER BY t.name ASC",
    )
    .bind(meeting_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
