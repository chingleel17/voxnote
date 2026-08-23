//! 講者聲紋比對：段落內合併、會議內串接、跨會議辨識三層，皆為提議，
//! 由呼叫端（Tauri commands）決定是否採納。純邏輯函式，不觸碰資料庫。

use serde::{Deserialize, Serialize};

/// cosine 距離（1 - cosine 相似度），pyannote 向量已 L2 正規化，範圍 0–2。
/// 距離愈小代表愈相似。
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return f32::MAX;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return f32::MAX;
    }
    1.0 - (dot / (norm_a * norm_b))
}

/// 單一講者代號的向量，附帶其所屬錄音段落。
#[derive(Debug, Clone)]
pub struct LabeledEmbedding {
    pub recording_id: String,
    pub speaker_label: String,
    pub vector: Vec<f32>,
}

/// 段落內合併 / 會議內串接提議：兩個講者代號的相似度達門檻，建議視為同一人。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeProposal {
    pub recording_id_a: String,
    pub speaker_label_a: String,
    pub recording_id_b: String,
    pub speaker_label_b: String,
    /// cosine 相似度（1 - 距離），愈大愈相似，供前端顯示
    pub similarity: f32,
}

/// 跨會議辨識提議：某講者代號與聲紋庫中某參與者相似度達門檻。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityProposal {
    pub recording_id: String,
    pub speaker_label: String,
    pub participant_id: String,
    pub participant_name: String,
    pub similarity: f32,
}

/// 單一錄音段落內，各講者代號兩兩比對，相似度達門檻者提議合併。
/// 門檻為 cosine 距離上限（距離愈小愈相似，故「達門檻」意為距離 <= threshold）。
pub fn propose_within_recording_merges(
    embeddings: &[LabeledEmbedding],
    distance_threshold: f32,
) -> Vec<MergeProposal> {
    let mut proposals = Vec::new();
    for i in 0..embeddings.len() {
        for j in (i + 1)..embeddings.len() {
            let a = &embeddings[i];
            let b = &embeddings[j];
            if a.recording_id != b.recording_id {
                continue;
            }
            let distance = cosine_distance(&a.vector, &b.vector);
            if distance <= distance_threshold {
                proposals.push(MergeProposal {
                    recording_id_a: a.recording_id.clone(),
                    speaker_label_a: a.speaker_label.clone(),
                    recording_id_b: b.recording_id.clone(),
                    speaker_label_b: b.speaker_label.clone(),
                    similarity: 1.0 - distance,
                });
            }
        }
    }
    proposals
}

/// 同一會議各錄音段落的講者向量互相比對，相似者提議串接為同一人。
/// 僅比對不同錄音段落間的講者代號；同一錄音段落內的比對屬於
/// `propose_within_recording_merges` 的職責，此處排除以免提議重複。
pub fn propose_cross_recording_links(
    embeddings: &[LabeledEmbedding],
    distance_threshold: f32,
) -> Vec<MergeProposal> {
    let mut proposals = Vec::new();
    for i in 0..embeddings.len() {
        for j in (i + 1)..embeddings.len() {
            let a = &embeddings[i];
            let b = &embeddings[j];
            if a.recording_id == b.recording_id {
                continue;
            }
            let distance = cosine_distance(&a.vector, &b.vector);
            if distance <= distance_threshold {
                proposals.push(MergeProposal {
                    recording_id_a: a.recording_id.clone(),
                    speaker_label_a: a.speaker_label.clone(),
                    recording_id_b: b.recording_id.clone(),
                    speaker_label_b: b.speaker_label.clone(),
                    similarity: 1.0 - distance,
                });
            }
        }
    }
    proposals
}

/// 聲紋庫中一筆已知身分的聲紋，供跨會議比對。
#[derive(Debug, Clone)]
pub struct KnownVoiceprint {
    pub participant_id: String,
    pub participant_name: String,
    pub vector: Vec<f32>,
}

/// 以本次向量比對聲紋庫，取每位講者代號與各參與者的最佳相似度（同一參與者
/// 可能有多筆聲紋，見 design 決策 4：比對時取最佳相似度）。低於門檻時該講者
/// 代號不產生任何候選，MUST NOT 退而提供最接近的候選。
pub fn propose_cross_meeting_identities(
    embeddings: &[LabeledEmbedding],
    voiceprints: &[KnownVoiceprint],
    distance_threshold: f32,
) -> Vec<IdentityProposal> {
    let mut proposals = Vec::new();
    for embedding in embeddings {
        let mut best: Option<(&KnownVoiceprint, f32)> = None;
        for voiceprint in voiceprints {
            let distance = cosine_distance(&embedding.vector, &voiceprint.vector);
            match best {
                Some((_, best_distance)) if distance >= best_distance => {}
                _ => best = Some((voiceprint, distance)),
            }
        }
        if let Some((voiceprint, distance)) = best {
            if distance <= distance_threshold {
                proposals.push(IdentityProposal {
                    recording_id: embedding.recording_id.clone(),
                    speaker_label: embedding.speaker_label.clone(),
                    participant_id: voiceprint.participant_id.clone(),
                    participant_name: voiceprint.participant_name.clone(),
                    similarity: 1.0 - distance,
                });
            }
        }
    }
    proposals
}

#[cfg(test)]
mod tests {
    use super::*;

    fn embedding(recording_id: &str, label: &str, vector: Vec<f32>) -> LabeledEmbedding {
        LabeledEmbedding {
            recording_id: recording_id.to_string(),
            speaker_label: label.to_string(),
            vector,
        }
    }

    #[test]
    fn cosine_distance_identical_vectors_is_zero() {
        let v = vec![0.6, 0.8];
        assert!(cosine_distance(&v, &v) < 1e-6);
    }

    #[test]
    fn cosine_distance_orthogonal_vectors_is_one() {
        let a = vec![1.0, 0.0];
        let b = vec![0.0, 1.0];
        assert!((cosine_distance(&a, &b) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn within_recording_merge_proposes_similar_speakers_in_same_recording() {
        let embeddings = vec![
            embedding("rec1", "A", vec![1.0, 0.0]),
            embedding("rec1", "B", vec![0.99, 0.01]),
            embedding("rec1", "C", vec![0.0, 1.0]),
        ];
        let proposals = propose_within_recording_merges(&embeddings, 0.1);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].speaker_label_a, "A");
        assert_eq!(proposals[0].speaker_label_b, "B");
    }

    #[test]
    fn within_recording_merge_ignores_cross_recording_pairs() {
        let embeddings = vec![
            embedding("rec1", "A", vec![1.0, 0.0]),
            embedding("rec2", "A", vec![1.0, 0.0]),
        ];
        let proposals = propose_within_recording_merges(&embeddings, 0.1);
        assert!(proposals.is_empty());
    }

    #[test]
    fn within_recording_merge_below_threshold_yields_no_proposal() {
        let embeddings = vec![
            embedding("rec1", "A", vec![1.0, 0.0]),
            embedding("rec1", "B", vec![0.0, 1.0]),
        ];
        let proposals = propose_within_recording_merges(&embeddings, 0.1);
        assert!(proposals.is_empty());
    }

    #[test]
    fn cross_recording_link_proposes_similar_speakers_across_recordings() {
        let embeddings = vec![
            embedding("rec1", "A", vec![1.0, 0.0]),
            embedding("rec2", "A", vec![0.99, 0.01]),
        ];
        let proposals = propose_cross_recording_links(&embeddings, 0.1);
        assert_eq!(proposals.len(), 1);
    }

    #[test]
    fn cross_recording_link_ignores_same_recording_pairs() {
        let embeddings = vec![
            embedding("rec1", "A", vec![1.0, 0.0]),
            embedding("rec1", "B", vec![0.99, 0.01]),
        ];
        let proposals = propose_cross_recording_links(&embeddings, 0.1);
        assert!(proposals.is_empty());
    }

    #[test]
    fn cross_meeting_identity_picks_best_similarity_across_multiple_voiceprints() {
        let embeddings = vec![embedding("rec1", "A", vec![1.0, 0.0])];
        let voiceprints = vec![
            KnownVoiceprint {
                participant_id: "p1".into(),
                participant_name: "王小明".into(),
                vector: vec![0.5, 0.5],
            },
            KnownVoiceprint {
                participant_id: "p1".into(),
                participant_name: "王小明".into(),
                vector: vec![0.99, 0.01],
            },
        ];
        let proposals = propose_cross_meeting_identities(&embeddings, &voiceprints, 0.1);
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].participant_name, "王小明");
    }

    #[test]
    fn cross_meeting_identity_below_threshold_yields_no_candidate() {
        let embeddings = vec![embedding("rec1", "A", vec![1.0, 0.0])];
        let voiceprints = vec![KnownVoiceprint {
            participant_id: "p1".into(),
            participant_name: "王小明".into(),
            vector: vec![0.0, 1.0],
        }];
        let proposals = propose_cross_meeting_identities(&embeddings, &voiceprints, 0.1);
        assert!(proposals.is_empty());
    }

    #[test]
    fn cross_meeting_identity_empty_voiceprint_library_yields_no_candidates() {
        let embeddings = vec![embedding("rec1", "A", vec![1.0, 0.0])];
        let proposals = propose_cross_meeting_identities(&embeddings, &[], 0.1);
        assert!(proposals.is_empty());
    }
}
