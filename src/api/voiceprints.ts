import { invoke } from '@tauri-apps/api/core';
import type { IdentityProposal, MergeProposal } from '../types';

/// 段落內合併提議：單一錄音段落內講者代號互相比對。
export const getWithinRecordingMergeProposals = (meetingId: string) =>
  invoke<MergeProposal[]>('get_within_recording_merge_proposals', { meetingId });

/// 會議內串接提議：同一會議跨錄音段落的講者代號互相比對。
export const getCrossRecordingLinkProposals = (meetingId: string) =>
  invoke<MergeProposal[]>('get_cross_recording_link_proposals', { meetingId });

/// 跨會議辨識提議：以本次向量比對聲紋庫中既有參與者。
export const getCrossMeetingIdentityProposals = (meetingId: string) =>
  invoke<IdentityProposal[]>('get_cross_meeting_identity_proposals', { meetingId });

/// 使用者確認講者對應時呼叫：將該講者的向量存入聲紋庫並繫結全域參與者。
export const confirmSpeakerVoiceprint = (recordingId: string, speakerLabel: string, participantId: string) =>
  invoke<void>('confirm_speaker_voiceprint', { recordingId, speakerLabel, participantId });
