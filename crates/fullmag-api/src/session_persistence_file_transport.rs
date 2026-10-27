//! Bounded binary FMS intake. The anonymous file is removed automatically on
//! cancellation/error; its bytes pass through the same staged archive verifier
//! as JSON/base64 imports. No upload creates scheduler authority or a session.
use std::fs::File;
use std::io::{Seek, SeekFrom};
use std::path::Path;
use std::time::Duration;

use axum::extract::Request;
use axum::http::{StatusCode, header};
use futures_core::Stream;
use tokio::io::AsyncWriteExt;

use crate::error::ApiError;
use crate::types::AppState;

pub(crate) const MAX_FMS_FILE_BYTES: usize = 512 * 1024 * 1024;
const FILE_UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);

fn invalid(message: impl std::fmt::Display) -> ApiError {
    ApiError::bad_request(format!("invalid_fms_file: {message}"))
}
fn too_large() -> ApiError {
    ApiError::with_status_and_code(
        StatusCode::PAYLOAD_TOO_LARGE,
        "fms_archive_too_large",
        "The archive exceeds the supported file upload limit.",
    )
}

pub(super) async fn receive(state: &AppState, request: Request) -> Result<File, ApiError> {
    let root = super::session_store_root(state).join("imports");
    receive_in(&root, request, MAX_FMS_FILE_BYTES, FILE_UPLOAD_TIMEOUT).await
}

async fn receive_in(
    root: &Path,
    request: Request,
    maximum: usize,
    deadline: Duration,
) -> Result<File, ApiError> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("application/octet-stream")
    {
        return Err(ApiError::with_status_and_code(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "fms_file_content_type",
            "FMS file uploads require application/octet-stream.",
        ));
    }
    if request
        .headers()
        .get(header::CONTENT_ENCODING)
        .is_some_and(|value| {
            !value
                .to_str()
                .is_ok_and(|text| text.trim().eq_ignore_ascii_case("identity"))
        })
    {
        return Err(ApiError::with_status_and_code(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "fms_file_content_encoding",
            "Encoded HTTP request bodies are not supported for archive uploads.",
        ));
    }
    if request
        .headers()
        .get_all(header::CONTENT_LENGTH)
        .iter()
        .count()
        > 1
    {
        return Err(invalid("multiple content-length headers"));
    }
    let declared = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .map(|value| {
            value
                .to_str()
                .map_err(invalid)?
                .parse::<u64>()
                .map_err(invalid)
        })
        .transpose()?;
    if declared.is_some_and(|length| length > maximum as u64) {
        return Err(too_large());
    }
    tokio::fs::create_dir_all(root).await.map_err(|error| {
        ApiError::internal(format!("creating archive intake directory: {error}"))
    })?;
    let file = tempfile::tempfile_in(root).map_err(|error| {
        ApiError::internal(format!("creating temporary archive intake: {error}"))
    })?;
    let mut file = tokio::fs::File::from_std(file);
    let mut body = request.into_body().into_data_stream();
    let transfer = async {
        let mut received = 0_u64;
        while let Some(frame) =
            std::future::poll_fn(|cx| std::pin::Pin::new(&mut body).poll_next(cx)).await
        {
            let bytes = frame.map_err(invalid)?;
            received = received
                .checked_add(bytes.len() as u64)
                .ok_or_else(too_large)?;
            if received > maximum as u64 {
                return Err(too_large());
            }
            file.write_all(&bytes).await.map_err(|error| {
                ApiError::internal(format!("writing temporary archive intake: {error}"))
            })?;
        }
        if received == 0 {
            return Err(invalid("archive is empty"));
        }
        if declared.is_some_and(|length| length != received) {
            return Err(invalid(
                "content-length differs from received archive bytes",
            ));
        }
        file.flush()
            .await
            .map_err(|error| ApiError::internal(format!("flushing archive intake: {error}")))?;
        Ok::<_, ApiError>(())
    };
    tokio::time::timeout(deadline, transfer)
        .await
        .map_err(|_| {
            ApiError::with_status_and_code(
                StatusCode::REQUEST_TIMEOUT,
                "fms_file_upload_timeout",
                "Archive upload timed out.",
            )
        })??;
    let mut file = file.into_std().await;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| ApiError::internal(format!("rewinding archive intake: {error}")))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use std::io::Read;

    fn request(body: Body, length: Option<&str>) -> Request {
        let mut builder =
            Request::builder().header(header::CONTENT_TYPE, "application/octet-stream");
        if let Some(length) = length {
            builder = builder.header(header::CONTENT_LENGTH, length);
        }
        builder.body(body).unwrap()
    }

    #[tokio::test]
    async fn exact_limit_preserves_file_bytes_and_leaves_no_named_upload() {
        let root = tempfile::tempdir().unwrap();
        for length in [None, Some("3")] {
            let mut file = receive_in(
                root.path(),
                request(Body::from("abc"), length),
                3,
                Duration::from_secs(1),
            )
            .await
            .unwrap();
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"abc");
            drop(file);
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }

    #[tokio::test]
    async fn rejects_declared_and_streamed_over_limit_without_retaining_files() {
        let root = tempfile::tempdir().unwrap();
        for length in [None, Some("4")] {
            let error = receive_in(
                root.path(),
                request(Body::from("abcd"), length),
                3,
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
            assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        }
        for (body, length) in [(Body::empty(), None), (Body::from("ab"), Some("3"))] {
            assert_eq!(
                receive_in(
                    root.path(),
                    request(body, length),
                    3,
                    Duration::from_secs(1)
                )
                .await
                .unwrap_err()
                .status,
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[tokio::test]
    async fn stream_error_and_timeout_leave_no_named_upload() {
        let root = tempfile::tempdir().unwrap();
        let broken = Body::from_stream(async_stream::stream! {
            yield Ok::<_, std::io::Error>(b"a".to_vec());
            yield Err(std::io::Error::other("test disconnected upload"));
        });
        assert_eq!(
            receive_in(
                root.path(),
                request(broken, None),
                3,
                Duration::from_secs(1)
            )
            .await
            .unwrap_err()
            .status,
            StatusCode::BAD_REQUEST
        );
        let stalled = Body::from_stream(async_stream::stream! {
            std::future::pending::<()>().await;
            yield Ok::<_, std::io::Error>(Vec::<u8>::new());
        });
        assert_eq!(
            receive_in(
                root.path(),
                request(stalled, None),
                3,
                Duration::from_millis(10)
            )
            .await
            .unwrap_err()
            .status,
            StatusCode::REQUEST_TIMEOUT
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn rejects_wrong_media_and_encoding_before_archive_intake() {
        let root = tempfile::tempdir().unwrap();
        let wrong = Request::builder()
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("abc"))
            .unwrap();
        assert_eq!(
            receive_in(root.path(), wrong, 3, Duration::from_secs(1))
                .await
                .unwrap_err()
                .status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        let mut encoded = request(Body::from("abc"), None);
        encoded
            .headers_mut()
            .insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
        assert_eq!(
            receive_in(root.path(), encoded, 3, Duration::from_secs(1))
                .await
                .unwrap_err()
                .status,
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
