use std::collections::HashMap;

use crate::db::models::Tag;
use chrono::Utc;
use sqlx::{Row, SqlitePool};
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

pub async fn update_tag(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    color: &str,
) -> Result<Tag, sqlx::Error> {
    sqlx::query("UPDATE tags SET name = ?, color = ? WHERE id = ?")
        .bind(name)
        .bind(color)
        .bind(id)
        .execute(pool)
        .await?;

    sqlx::query_as::<_, Tag>("SELECT id, name, color, created_at FROM tags WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
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

pub async fn get_tags_for_meeting_ids(
    pool: &SqlitePool,
    meeting_ids: &[String],
) -> Result<HashMap<String, Vec<Tag>>, sqlx::Error> {
    if meeting_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = vec!["?"; meeting_ids.len()].join(", ");
    let sql = format!(
        "SELECT mt.meeting_id, t.id, t.name, t.color, t.created_at
         FROM meeting_tags mt
         INNER JOIN tags t ON t.id = mt.tag_id
         WHERE mt.meeting_id IN ({placeholders})
         ORDER BY t.name ASC"
    );

    let mut query = sqlx::query(&sql);
    for meeting_id in meeting_ids {
        query = query.bind(meeting_id);
    }

    let rows = query.fetch_all(pool).await?;
    let mut tags_by_meeting: HashMap<String, Vec<Tag>> = HashMap::new();

    for row in rows {
        let meeting_id: String = row.get("meeting_id");
        let tag = Tag {
            id: row.get("id"),
            name: row.get("name"),
            color: row.get("color"),
            created_at: row.get("created_at"),
        };
        tags_by_meeting.entry(meeting_id).or_default().push(tag);
    }

    Ok(tags_by_meeting)
}
