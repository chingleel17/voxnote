//! 即時字幕的 LocalAgreement-2 穩定化政策。

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgreementUpdate {
    /// 本次新進入確定狀態的文字。
    pub newly_confirmed: String,
    /// 目前尚未達成一致、仍可被後續解碼修正的文字。
    pub tentative: String,
    /// 目前字幕段落中累積且不可撤回的確定文字。
    pub confirmed: String,
}

#[derive(Debug, Default, Clone)]
pub struct LocalAgreement {
    previous_result: Option<String>,
    confirmed: String,
    tentative: String,
}

impl LocalAgreement {
    pub fn update(&mut self, result: &str) -> AgreementUpdate {
        let result = result.trim();
        let previous = self.previous_result.as_deref().unwrap_or("");
        let common = common_prefix(previous, result);
        let confirmed_len = self.confirmed.chars().count();
        let common_chars: Vec<char> = common.chars().collect();

        let newly_confirmed = if common_chars.len() > confirmed_len {
            let value: String = common_chars.iter().skip(confirmed_len).collect();
            self.confirmed = common;
            value
        } else {
            String::new()
        };

        self.tentative = if result.starts_with(&self.confirmed) {
            result
                .chars()
                .skip(self.confirmed.chars().count())
                .collect()
        } else {
            result.to_string()
        };
        self.previous_result = Some(result.to_string());

        AgreementUpdate {
            newly_confirmed,
            tentative: self.tentative.clone(),
            confirmed: self.confirmed.clone(),
        }
    }

    /// session 結束時，暫定文字不得因未取得第二次一致結果而遺失。
    pub fn finish(&mut self) -> AgreementUpdate {
        let newly_confirmed = self.tentative.clone();
        self.confirmed.push_str(&self.tentative);
        self.tentative.clear();
        self.previous_result = None;
        AgreementUpdate {
            newly_confirmed,
            tentative: String::new(),
            confirmed: self.confirmed.clone(),
        }
    }

    pub fn has_text(&self) -> bool {
        !self.confirmed.is_empty() || !self.tentative.is_empty()
    }
}

fn common_prefix(previous: &str, current: &str) -> String {
    let previous_tokens = tokenize(previous);
    let current_tokens = tokenize(current);
    let count = previous_tokens
        .iter()
        .zip(current_tokens.iter())
        .take_while(|(left, right)| left == right)
        .count();
    join_tokens(&current_tokens[..count], current)
}

fn tokenize(value: &str) -> Vec<String> {
    if value
        .chars()
        .any(|character| character.is_ascii_alphabetic())
    {
        value.split_whitespace().map(ToString::to_string).collect()
    } else {
        value
            .chars()
            .map(|character| character.to_string())
            .collect()
    }
}

fn join_tokens(tokens: &[String], original: &str) -> String {
    if original
        .chars()
        .any(|character| character.is_ascii_alphabetic())
    {
        tokens.join(" ")
    } else {
        tokens.concat()
    }
}

#[cfg(test)]
mod tests {
    use super::LocalAgreement;

    #[test]
    fn consecutive_chinese_decodes_confirm_common_prefix() {
        let mut agreement = LocalAgreement::default();
        assert_eq!(agreement.update("今天討論系統").tentative, "今天討論系統");
        let update = agreement.update("今天討論資料庫");
        assert_eq!(update.newly_confirmed, "今天討論");
        assert_eq!(update.tentative, "資料庫");
    }

    #[test]
    fn consecutive_disagreement_keeps_text_tentative() {
        let mut agreement = LocalAgreement::default();
        agreement.update("今天討論");
        let update = agreement.update("明天測試");
        assert!(update.newly_confirmed.is_empty());
        assert_eq!(update.tentative, "明天測試");
    }

    #[test]
    fn confirmed_text_is_not_revised() {
        let mut agreement = LocalAgreement::default();
        agreement.update("今天討論系統");
        agreement.update("今天討論資料庫");
        let update = agreement.update("今天討論硬體");
        assert_eq!(update.confirmed, "今天討論");
        assert_eq!(update.tentative, "硬體");
    }

    #[test]
    fn changed_result_does_not_clear_confirmed_text() {
        let mut agreement = LocalAgreement::default();
        agreement.update("今天討論系統");
        agreement.update("今天討論資料庫");
        let update = agreement.update("完全不同的內容");
        assert_eq!(update.confirmed, "今天討論");
        assert_eq!(update.tentative, "完全不同的內容");
    }

    #[test]
    fn finish_promotes_tentative_text() {
        let mut agreement = LocalAgreement::default();
        agreement.update("尚未確認");
        let update = agreement.finish();
        assert_eq!(update.newly_confirmed, "尚未確認");
        assert!(update.tentative.is_empty());
        assert_eq!(update.confirmed, "尚未確認");
    }

    #[test]
    fn english_agreement_uses_whitespace_token_granularity() {
        let mut agreement = LocalAgreement::default();
        agreement.update("we are testing");
        let update = agreement.update("we are deploying");
        assert_eq!(update.newly_confirmed, "we are");
        assert_eq!(update.tentative, " deploying");
    }
}
