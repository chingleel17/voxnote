use anyhow::Result;
use chrono::Utc;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use super::models::{CreateMeetingRequest, MeetingWithDetails, UpdateMeetingRequest};
use super::tag::{get_tags_for_meeting_ids, set_meeting_tags};

const MEETING_SELECT_SQL: &str = r#"
    SELECT
        m.id,
        m.title,
        m.category_id,
        c.name AS category_name,
        GROUP_CONCAT(p.name, ',') AS participants_concat,
        CAST(EXISTS(SELECT 1 FROM transcripts t WHERE t.meeting_id = m.id) AS INTEGER) AS has_transcript,
        CAST(EXISTS(SELECT 1 FROM summaries s WHERE s.meeting_id = m.id) AS INTEGER) AS has_summary,
        m.meeting_date,
        m.archived_at,
        m.archived_path,
        m.created_at,
        m.updated_at
    FROM meetings m
    LEFT JOIN categories c ON m.category_id = c.id
    LEFT JOIN participants p ON p.meeting_id = m.id
    GROUP BY m.id
"#;

fn row_to_meeting(row: &sqlx::sqlite::SqliteRow) -> MeetingWithDetails {
    let participants_concat: Option<String> = row.get("participants_concat");
    let participants = participants_concat
        .unwrap_or_default()
        .split(',')
        .filter(|s: &&str| !s.is_empty())
        .map(String::from)
        .collect();
    let has_transcript: i64 = row.try_get("has_transcript").unwrap_or(0);
    let has_summary: i64 = row.try_get("has_summary").unwrap_or(0);
    MeetingWithDetails {
        id: row.get("id"),
        title: row.get("title"),
        category_id: row.get("category_id"),
        category_name: row.get("category_name"),
        participants,
        has_transcript: has_transcript != 0,
        has_summary: has_summary != 0,
        tags: vec![],
        meeting_date: row.get("meeting_date"),
        archived_at: row.get("archived_at"),
        archived_path: row.get("archived_path"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

pub async fn get_meetings(pool: &SqlitePool) -> Result<Vec<MeetingWithDetails>> {
    let sql = format!("{} HAVING m.archived_at IS NULL ORDER BY m.created_at DESC", MEETING_SELECT_SQL);
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    let mut meetings: Vec<MeetingWithDetails> = rows.iter().map(row_to_meeting).collect();
    let meeting_ids: Vec<String> = meetings.iter().map(|meeting| meeting.id.clone()).collect();
    let tags_by_meeting = get_tags_for_meeting_ids(pool, &meeting_ids).await?;
    for meeting in &mut meetings {
        meeting.tags = tags_by_meeting
            .get(&meeting.id)
            .cloned()
            .unwrap_or_default();
    }
    Ok(meetings)
}

pub async fn get_archived_meetings(pool: &SqlitePool) -> Result<Vec<MeetingWithDetails>> {
    let sql = format!(
        "{} HAVING m.archived_at IS NOT NULL ORDER BY m.archived_at DESC, m.updated_at DESC",
        MEETING_SELECT_SQL
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;
    let mut meetings: Vec<MeetingWithDetails> = rows.iter().map(row_to_meeting).collect();
    let meeting_ids: Vec<String> = meetings.iter().map(|meeting| meeting.id.clone()).collect();
    let tags_by_meeting = get_tags_for_meeting_ids(pool, &meeting_ids).await?;
    for meeting in &mut meetings {
        meeting.tags = tags_by_meeting
            .get(&meeting.id)
            .cloned()
            .unwrap_or_default();
    }
    Ok(meetings)
}

pub async fn get_meeting(pool: &SqlitePool, id: &str) -> Result<Option<MeetingWithDetails>> {
    let sql = format!("{} HAVING m.id = ?", MEETING_SELECT_SQL);
    let row = sqlx::query(&sql).bind(id).fetch_optional(pool).await?;
    let mut meeting = match row.as_ref().map(row_to_meeting) {
        Some(m) => m,
        None => return Ok(None),
    };
    let mut tags_by_meeting = get_tags_for_meeting_ids(pool, &[meeting.id.clone()]).await?;
    meeting.tags = tags_by_meeting.remove(&meeting.id).unwrap_or_default();
    Ok(Some(meeting))
}

pub async fn create_meeting(
    pool: &SqlitePool,
    req: CreateMeetingRequest,
) -> Result<MeetingWithDetails> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    let mut tx = pool.begin().await?;

    sqlx::query("INSERT INTO meetings (id, title, category_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&req.title)
        .bind(&req.category_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

    for name in &req.participants {
        let pid = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO participants (id, meeting_id, name) VALUES (?, ?, ?)")
            .bind(&pid)
            .bind(&id)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    if let Some(tag_ids) = &req.tag_ids {
        if !tag_ids.is_empty() {
            let _ = set_meeting_tags(pool, &id, tag_ids).await;
        }
    }

    get_meeting(pool, &id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("會議建立後無法取得"))
}

pub async fn update_meeting(
    pool: &SqlitePool,
    id: &str,
    req: UpdateMeetingRequest,
) -> Result<MeetingWithDetails> {
    let now = Utc::now().to_rfc3339();

    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE meetings SET title = ?, category_id = ?, meeting_date = ?, updated_at = ? WHERE id = ?")
        .bind(&req.title)
        .bind(&req.category_id)
        .bind(&req.meeting_date)
        .bind(&now)
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM participants WHERE meeting_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    for name in &req.participants {
        let pid = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO participants (id, meeting_id, name) VALUES (?, ?, ?)")
            .bind(&pid)
            .bind(id)
            .bind(name)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    if let Some(tag_ids) = &req.tag_ids {
        let _ = set_meeting_tags(pool, id, tag_ids).await;
    }

    get_meeting(pool, id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("會議更新後無法取得"))
}

pub async fn delete_meeting(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM meetings WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn archive_meeting(pool: &SqlitePool, id: &str, archived_path: Option<&str>) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("UPDATE meetings SET archived_at = ?, archived_path = ?, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(archived_path)
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn unarchive_meeting(pool: &SqlitePool, id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    sqlx::query("UPDATE meetings SET archived_at = NULL, archived_path = NULL, updated_at = ? WHERE id = ?")
        .bind(&now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
