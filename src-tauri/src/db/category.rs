use anyhow::Result;
use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::models::Category;

pub async fn get_categories(pool: &SqlitePool) -> Result<Vec<Category>> {
    let rows = sqlx::query_as::<_, Category>(
        "SELECT id, name, created_at FROM categories ORDER BY name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn create_category(pool: &SqlitePool, name: &str) -> Result<Category> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();

    sqlx::query("INSERT INTO categories (id, name, created_at) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(name)
        .bind(&now)
        .execute(pool)
        .await?;

    Ok(Category {
        id,
        name: name.to_string(),
        created_at: now,
    })
}

pub async fn update_category(pool: &SqlitePool, id: &str, name: &str) -> Result<Category> {
    sqlx::query("UPDATE categories SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;

    sqlx::query_as::<_, Category>("SELECT id, name, created_at FROM categories WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn delete_category(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query("UPDATE meetings SET category_id = NULL WHERE category_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM categories WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(())
}
