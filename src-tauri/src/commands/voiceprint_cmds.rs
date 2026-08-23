use sqlx::SqlitePool;
use tauri::{AppHandle, State};

use crate::{
    backup::DataOperationLock,
    config::load_config,
    db::{saved_participant, voiceprint},
    voiceprint::{
        propose_cross_meeting_identities, propose_cross_recording_links,
        propose_within_recording_merges, IdentityProposal, KnownVoiceprint, LabeledEmbedding,
        MergeProposal,
    },
};

async fn load_meeting_embeddings(
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<Vec<LabeledEmbedding>, String> {
    let rows = voiceprint::get_recording_speaker_embeddings_by_meeting(pool, meeting_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|row| LabeledEmbedding {
            recording_id: row.recording_id,
            speaker_label: row.speaker_label,
            vector: voiceprint::deserialize_vector(&row.vector),
        })
        .collect())
}

/// 取得同一會議內的段落內合併提議（單一錄音段落內講者代號互相比對）。
#[tauri::command]
pub async fn get_within_recording_merge_proposals(
    meeting_id: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<Vec<MergeProposal>, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;
    let embeddings = load_meeting_embeddings(&pool, &meeting_id).await?;
    Ok(propose_within_recording_merges(
        &embeddings,
        config.voiceprint_similarity_threshold,
    ))
}

/// 取得同一會議跨錄音段落的講者串接提議。
#[tauri::command]
pub async fn get_cross_recording_link_proposals(
    meeting_id: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<Vec<MergeProposal>, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;
    let embeddings = load_meeting_embeddings(&pool, &meeting_id).await?;
    Ok(propose_cross_recording_links(
        &embeddings,
        config.voiceprint_similarity_threshold,
    ))
}

/// 取得跨會議辨識提議：以本次向量比對聲紋庫中既有參與者（僅模型相符者）。
/// 不同錄音段落可能因設定變更而使用不同 diarization 模型，故依模型分組後
/// 分別查詢聲紋庫，而非假設整場會議單一模型。
#[tauri::command]
pub async fn get_cross_meeting_identity_proposals(
    meeting_id: String,
    app: AppHandle,
    pool: State<'_, SqlitePool>,
) -> Result<Vec<IdentityProposal>, String> {
    let config = load_config(&app).map_err(|e| e.to_string())?;
    let recording_embeddings =
        voiceprint::get_recording_speaker_embeddings_by_meeting(&pool, &meeting_id)
            .await
            .map_err(|e| e.to_string())?;

    let all_participants = saved_participant::get_saved_participants(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut proposals = Vec::new();
    let mut handled_models: Vec<String> = Vec::new();
    for model in recording_embeddings.iter().map(|row| row.model.clone()) {
        if handled_models.contains(&model) {
            continue;
        }
        handled_models.push(model.clone());

        let embeddings: Vec<LabeledEmbedding> = recording_embeddings
            .iter()
            .filter(|row| row.model == model)
            .map(|row| LabeledEmbedding {
                recording_id: row.recording_id.clone(),
                speaker_label: row.speaker_label.clone(),
                vector: voiceprint::deserialize_vector(&row.vector),
            })
            .collect();

        let voiceprints = voiceprint::get_voiceprints_by_model(&pool, &model)
            .await
            .map_err(|e| e.to_string())?;
        let known: Vec<KnownVoiceprint> = voiceprints
            .into_iter()
            .filter_map(|vp| {
                all_participants
                    .iter()
                    .find(|p| p.id == vp.participant_id)
                    .map(|participant| KnownVoiceprint {
                        participant_id: vp.participant_id.clone(),
                        participant_name: participant.name.clone(),
                        vector: voiceprint::deserialize_vector(&vp.vector),
                    })
            })
            .collect();

        proposals.extend(propose_cross_meeting_identities(
            &embeddings,
            &known,
            config.voiceprint_similarity_threshold,
        ));
    }
    Ok(proposals)
}

/// 使用者確認講者對應時呼叫：從暫存的錄音段落向量讀出對應向量，寫入聲紋庫
/// 並繫結指定的全域參與者。向量不存在時（如未啟用語者分離）靜默略過，不視為錯誤。
#[tauri::command]
pub async fn confirm_speaker_voiceprint(
    recording_id: String,
    speaker_label: String,
    participant_id: String,
    pool: State<'_, SqlitePool>,
    data_lock: State<'_, DataOperationLock>,
) -> Result<(), String> {
    let _guard = data_lock.try_begin_write()?;
    let rows = voiceprint::get_recording_speaker_embeddings_by_recording(&pool, &recording_id)
        .await
        .map_err(|e| e.to_string())?;
    let Some(row) = rows.into_iter().find(|r| r.speaker_label == speaker_label) else {
        return Ok(());
    };
    let vector = voiceprint::deserialize_vector(&row.vector);
    voiceprint::insert_voiceprint(&pool, &participant_id, &row.model, &vector)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
