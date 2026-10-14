using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Fullmag.Setup.UI.Broker;

public static class BrokerProtocol
{
    public const string Schema = "fullmag.windows-installer-ui.v1";
    public const int Version = 1;
    public const string VersionString = "1.0.0";
    public const string Architecture = "x64";
    // Keep this equal to the native BA's bounded JSON-line reader.  The limit
    // is measured after UTF-8 encoding, not by the .NET string's UTF-16 length.
    public const int MaxLineLength = 2_097_152;
}

/// <summary>
/// A command sent to the already-running native BA over inherited private stdio.
/// The operation name lives inside payload so the transport envelope remains the
/// BA's stable type/request/generation/revision contract.
/// </summary>
public sealed record BrokerRequest(
    [property: JsonPropertyName("schema")] string Schema,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("request_id")] string RequestId,
    [property: JsonPropertyName("generation")] long Generation,
    [property: JsonPropertyName("revision")] long Revision,
    [property: JsonPropertyName("payload")] JsonElement Payload);

public sealed record BrokerHello(
    [property: JsonPropertyName("schema")] string Schema,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("arch")] string Architecture);

public sealed class BrokerResponseEnvelope
{
    [JsonPropertyName("schema")]
    public string? Schema { get; set; }

    [JsonPropertyName("version")]
    public JsonElement Version { get; set; }

    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("request_id")]
    public string? RequestId { get; set; }

    [JsonPropertyName("generation")]
    public long? Generation { get; set; }

    [JsonPropertyName("revision")]
    public long? Revision { get; set; }

    [JsonPropertyName("state")]
    public string? State { get; set; }

    [JsonPropertyName("ok")]
    public bool Ok { get; set; }

    [JsonPropertyName("progress")]
    public int? Progress { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("payload")]
    public JsonElement Payload { get; set; }

    [JsonPropertyName("errors")]
    public string[]? Errors { get; set; }

    public BrokerResponse ToResponse()
    {
        var payload = Payload.ValueKind == JsonValueKind.Undefined
            ? JsonSerializer.SerializeToElement(new Dictionary<string, object?>())
            : Payload;
        return new BrokerResponse(
            Schema ?? string.Empty,
            ParseVersion(Version),
            Type ?? string.Empty,
            RequestId ?? string.Empty,
            Generation ?? 0,
            Revision ?? 0,
            State ?? string.Empty,
            Ok,
            Progress,
            Message ?? string.Empty,
            payload,
            Errors ?? Array.Empty<string>());
    }

    private static int ParseVersion(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
        {
            return number;
        }

        if (value.ValueKind == JsonValueKind.String &&
            string.Equals(value.GetString(), BrokerProtocol.VersionString, StringComparison.Ordinal))
        {
            return BrokerProtocol.Version;
        }

        return 0;
    }
}

public sealed record BrokerResponse(
    string Schema,
    int Version,
    string Type,
    string RequestId,
    long Generation,
    long Revision,
    string State,
    bool Ok,
    int? Progress,
    string Message,
    JsonElement Payload,
    IReadOnlyList<string> Errors)
{
    // These aliases keep view-model wording independent of the wire vocabulary.
    public string Kind => Type;
    public string CorrelationId => RequestId;

    public bool IsTerminal =>
        string.Equals(Type, "error", StringComparison.OrdinalIgnoreCase) ||
        (string.Equals(Type, "reply", StringComparison.OrdinalIgnoreCase) &&
         (string.Equals(State, "complete", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "blocked", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "stale", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "canceled", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "error", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "failed", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "committed", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "unchanged", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "ready", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "success", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "succeeded", StringComparison.OrdinalIgnoreCase))) ||
        ((string.Equals(Type, "state", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(Type, "burn", StringComparison.OrdinalIgnoreCase)) &&
         (string.Equals(State, "complete", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "blocked", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "stale", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "canceled", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "error", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "failed", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "committed", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "unchanged", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "ready", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "success", StringComparison.OrdinalIgnoreCase) ||
          string.Equals(State, "succeeded", StringComparison.OrdinalIgnoreCase)));

    public static BrokerResponse Blocked(string requestId, string message) => new(
        BrokerProtocol.Schema,
        BrokerProtocol.Version,
        "reply",
        requestId,
        0,
        0,
        "blocked",
        false,
        null,
        message,
        JsonSerializer.SerializeToElement(new Dictionary<string, object?>()),
        new[] { message });
}

public sealed class BrokerTransportException : Exception
{
    public BrokerTransportException(string message) : base(message)
    {
    }

    public BrokerTransportException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

public interface IBrokerClient : IAsyncDisposable
{
    event EventHandler<BrokerResponse>? EventReceived;

    Task StartAsync(CancellationToken cancellationToken = default);

    Task<BrokerResponse> SendAsync(
        string operation,
        object payload,
        CancellationToken cancellationToken = default);

    Task ShutdownAsync();
}
