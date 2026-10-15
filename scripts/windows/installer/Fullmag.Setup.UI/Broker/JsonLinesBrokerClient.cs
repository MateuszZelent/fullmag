using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Fullmag.Setup.UI.Broker;

/// <summary>
/// JSON-lines client for the private stdio session created by the native BA.
/// This type deliberately has no process-launching capability: the BA owns the
/// verified GUI process and its inherited pipe handles.
/// </summary>
public sealed class JsonLinesBrokerClient : IBrokerClient
{
    private static readonly TimeSpan ShutdownTimeout = TimeSpan.FromSeconds(2);

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false
    };

    private readonly Stream _input;
    private readonly Stream _output;
    private readonly StreamReader _reader;
    private readonly StreamWriter _writer;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<BrokerResponse>> _pending = new();
    private readonly SemaphoreSlim _startGate = new(1, 1);
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly CancellationTokenSource _lifetime = new();
    private readonly CancellationTokenSource _transportAbort = new();
    private readonly object _stateGate = new();
    private readonly char[] _readBuffer = new char[4 * 1024];
    private TaskCompletionSource<BrokerResponse>? _initCompletion;
    private Task? _readerTask;
    private Task? _shutdownTask;
    private Exception? _terminalError;
    private long _generation;
    private long _revision;
    private long _nextCommandRevision;
    private int _readBufferOffset;
    private int _readBufferCount;
    private int _startWaiters;
    private int _writeGateReleaseUncertain;
    private int _streamsClosed;
    private int _disposeStarted;
    private bool _started;
    private bool _handshakeComplete;
    private bool _shutdownRequested;

    public JsonLinesBrokerClient(Stream input, Stream output)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(output);
        _input = input;
        _output = output;
        _reader = new StreamReader(
            input,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            detectEncodingFromByteOrderMarks: false,
            bufferSize: 64 * 1024,
            leaveOpen: true);
        _writer = new StreamWriter(
            output,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
            bufferSize: 64 * 1024,
            leaveOpen: true)
        {
            NewLine = "\n"
        };
    }

    public event EventHandler<BrokerResponse>? EventReceived;

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        lock (_stateGate)
        {
            if (_disposeStarted != 0)
            {
                throw new ObjectDisposedException(nameof(JsonLinesBrokerClient));
            }
            Interlocked.Increment(ref _startWaiters);
        }
        var gateAcquired = false;
        try
        {
            await _startGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            gateAcquired = true;
            lock (_stateGate)
            {
                if (_terminalError is not null)
                {
                    throw new BrokerTransportException(
                        "The installer UI connection is no longer available.",
                        _terminalError);
                }

                if (_handshakeComplete)
                {
                    return;
                }

                if (_shutdownRequested)
                {
                    throw new ObjectDisposedException(nameof(JsonLinesBrokerClient));
                }

                if (!_started)
                {
                    _started = true;
                    _initCompletion = new TaskCompletionSource<BrokerResponse>(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                    _readerTask = ReadResponsesAsync(_lifetime.Token);
                }
            }

            var hello = new BrokerHello(
                BrokerProtocol.Schema,
                "hello",
                BrokerProtocol.VersionString,
                BrokerProtocol.Architecture);
            await WriteFrameAsync(hello, cancellationToken, permitBeforeHandshake: true)
                .ConfigureAwait(false);

            TaskCompletionSource<BrokerResponse> init;
            lock (_stateGate)
            {
                init = _initCompletion ?? throw new BrokerTransportException(
                    "The installer UI handshake was not initialized.");
            }

            BrokerResponse initResponse;
            try
            {
                initResponse = await init.Task.WaitAsync(
                    TimeSpan.FromSeconds(15),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (TimeoutException exception)
            {
                throw new BrokerTransportException(
                    "The native installer did not provide its UI session.",
                    exception);
            }

            if (!initResponse.Ok &&
                string.Equals(initResponse.Type, "error", StringComparison.OrdinalIgnoreCase))
            {
                throw new BrokerTransportException(
                    string.IsNullOrWhiteSpace(initResponse.Message)
                        ? "The native installer rejected the UI session."
                        : initResponse.Message);
            }

            lock (_stateGate)
            {
                if (_shutdownRequested)
                {
                    throw new ObjectDisposedException(nameof(JsonLinesBrokerClient));
                }

                if (_terminalError is not null)
                {
                    throw new BrokerTransportException(
                        "The installer UI connection is no longer available.",
                        _terminalError);
                }

                _handshakeComplete = true;
            }
        }
        finally
        {
            if (gateAcquired)
            {
                _startGate.Release();
            }
            Interlocked.Decrement(ref _startWaiters);
        }
    }

    public async Task<BrokerResponse> SendAsync(
        string operation,
        object payload,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(operation))
        {
            throw new ArgumentException("An installer operation is required.", nameof(operation));
        }

        await StartAsync(cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();

        var requestId = Guid.NewGuid().ToString("D");
        var completion = new TaskCompletionSource<BrokerResponse>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_pending.TryAdd(requestId, completion))
        {
            throw new BrokerTransportException("The installer operation could not be registered.");
        }

        try
        {
            await WriteCommandFrameAsync(
                operation,
                payload,
                requestId,
                cancellationToken).ConfigureAwait(false);
            using var cancellationRegistration = cancellationToken.Register(
                static state => ((TaskCompletionSource<BrokerResponse>)state!).TrySetCanceled(),
                completion);
            return await completion.Task.ConfigureAwait(false);
        }
        catch
        {
            _pending.TryRemove(requestId, out _);
            throw;
        }
    }

    public Task ShutdownAsync()
    {
        lock (_stateGate)
        {
            _shutdownTask ??= ShutdownCoreAsync();
            return _shutdownTask;
        }
    }

    private async Task ShutdownCoreAsync()
    {
        Task? readerTask = null;
        var gateAcquired = false;
        var sendShutdown = false;
        long shutdownGeneration = 0;
        long shutdownRevision = 0;
        var closing = new BrokerTransportException("The installer UI connection is closing.");
        var shutdownBudget = new CancellationTokenSource(ShutdownTimeout);
        var shutdownToken = shutdownBudget.Token;

        try
        {
            lock (_stateGate)
            {
                sendShutdown = _started && _handshakeComplete;
                _shutdownRequested = true;
                _handshakeComplete = false;
                _terminalError ??= closing;
                _initCompletion?.TrySetException(closing);
                readerTask = _readerTask;
            }
            FailPending(closing);

            try
            {
                try
                {
                    await _writeGate.WaitAsync(shutdownToken).ConfigureAwait(false);
                    gateAcquired = true;
                }
                catch (OperationCanceledException)
                {
                    // A normal command may still be blocked in a synchronous
                    // console-pipe write.  Cancel the facade and stop waiting
                    // for the gate; Console.OpenStandard* keeps the native
                    // handle lifecycle with the BA/process.
                    sendShutdown = false;
                    // A writer may still own the gate after the deadline.
                    // Mark it permanently uncertain before aborting so a
                    // late continuation can never make the gate reusable.
                    Volatile.Write(ref _writeGateReleaseUncertain, 1);
                    AbortTransport();
                }

                if (gateAcquired && sendShutdown &&
                    Volatile.Read(ref _writeGateReleaseUncertain) == 0)
                {
                    lock (_stateGate)
                    {
                        if (!_shutdownRequested ||
                            Volatile.Read(ref _writeGateReleaseUncertain) != 0)
                        {
                            sendShutdown = false;
                        }
                        else
                        {
                            // The gate is held while this revision is
                            // allocated, so shutdown cannot overtake a
                            // command that was already put on the wire.
                            shutdownGeneration = _generation;
                            shutdownRevision = NextCommandRevisionLocked();
                        }
                    }

                    if (sendShutdown)
                    {
                        try
                        {
                            var shutdown = new BrokerRequest(
                                BrokerProtocol.Schema,
                                "shutdown",
                                BrokerProtocol.VersionString,
                                Guid.NewGuid().ToString("D"),
                                shutdownGeneration,
                                shutdownRevision,
                                JsonSerializer.SerializeToElement(new Dictionary<string, object?>()));
                            await WriteFrameUnderGateAsync(
                                shutdown,
                                shutdownToken,
                                permitShutdown: true).ConfigureAwait(false);
                        }
                        catch (Exception)
                        {
                            // The inherited pipe is only a best-effort
                            // notification; the native BA owns process
                            // lifetime and inherited pipe teardown.
                        }
                    }
                }
            }
            catch (Exception exception)
            {
                // Teardown must remain bounded even when the pipe fails
                // between gate acquisition and the shutdown frame.
                InvalidateTransport(exception);
            }
            finally
            {
                if (gateAcquired && Volatile.Read(ref _writeGateReleaseUncertain) == 0)
                {
                    try
                    {
                        _writeGate.Release();
                    }
                    catch (ObjectDisposedException)
                    {
                        Volatile.Write(ref _writeGateReleaseUncertain, 1);
                    }
                }
            }
        }
        finally
        {
            try
            {
                _transportAbort.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            try
            {
                _lifetime.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            FailPending(closing);

            if (readerTask is not null)
            {
                try
                {
                    await readerTask.WaitAsync(shutdownToken).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    // Facade disposal below prevents a later wrapper flush
                    // from extending shutdown; a native console-pipe write
                    // may live until the BA/process owns its final teardown.
                }
            }

            DisposeStreams();
            if (Volatile.Read(ref _writeGateReleaseUncertain) == 0)
            {
                shutdownBudget.Dispose();
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await ShutdownAsync().ConfigureAwait(false);
        lock (_stateGate)
        {
            if (_disposeStarted != 0)
            {
                return;
            }
            _disposeStarted = 1;
        }

        // Do not dispose the managed gates or cancellation sources here.
        // A bounded shutdown can return while a canceled writer is still
        // unwinding a synchronous console-pipe call.  Keeping these managed
        // objects alive prevents a late waiter/release or cancellation
        // callback from racing disposal; they become collectible with the
        // client after the BA owns final process teardown.
    }

    private async Task ReadResponsesAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                var line = await ReadFrameAsync(cancellationToken).ConfigureAwait(false);
                if (line is null)
                {
                    throw new BrokerTransportException("The native installer closed its UI connection.");
                }

                if (line.Length == 0)
                {
                    throw new BrokerTransportException("The native installer returned an invalid UI frame.");
                }

                BrokerResponse response;
                try
                {
                    var envelope = JsonSerializer.Deserialize<BrokerResponseEnvelope>(line, SerializerOptions);
                    response = envelope?.ToResponse()
                        ?? throw new JsonException("Missing UI response envelope.");
                }
                catch (JsonException exception)
                {
                    throw new BrokerTransportException("The native installer returned invalid UI JSON.", exception);
                }

                ValidateResponse(response);
                if (!TryObserve(response))
                {
                    if (!string.IsNullOrWhiteSpace(response.RequestId) &&
                        _pending.TryRemove(response.RequestId, out var staleCompletion))
                    {
                        staleCompletion.TrySetException(new BrokerTransportException(
                            "The native installer returned a stale response for this operation."));
                    }
                    continue;
                }

                if (string.Equals(response.Type, "init", StringComparison.OrdinalIgnoreCase))
                {
                    lock (_stateGate)
                    {
                        _initCompletion?.TrySetResult(response);
                    }
                    RaiseEvent(response);
                    continue;
                }

                if (string.Equals(response.Type, "reply", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(response.Type, "error", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(response.Type, "state", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(response.Type, "burn", StringComparison.OrdinalIgnoreCase))
                {
                    if (!string.IsNullOrWhiteSpace(response.RequestId) &&
                        response.IsTerminal &&
                        _pending.TryRemove(response.RequestId, out var completion))
                    {
                        completion.TrySetResult(response);
                        continue;
                    }
                }

                RaiseEvent(response);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            MarkTerminalFailure(exception);
        }
    }

    private async Task<string?> ReadFrameAsync(CancellationToken cancellationToken)
    {
        var builder = new StringBuilder();
        var encoder = new UTF8Encoding(
            encoderShouldEmitUTF8Identifier: false,
            throwOnInvalidBytes: true).GetEncoder();
        var utf8Bytes = 0;

        while (true)
        {
            if (_readBufferOffset >= _readBufferCount)
            {
                _readBufferCount = await _reader.ReadAsync(
                    _readBuffer.AsMemory(),
                    cancellationToken).ConfigureAwait(false);
                _readBufferOffset = 0;
                if (_readBufferCount == 0)
                {
                    if (builder.Length == 0)
                    {
                        return null;
                    }

                    throw new BrokerTransportException(
                        "The native installer closed its UI connection mid-frame.");
                }
            }

            var segmentStart = _readBufferOffset;
            while (_readBufferOffset < _readBufferCount &&
                   _readBuffer[_readBufferOffset] != '\n')
            {
                _readBufferOffset++;
            }

            var segmentLength = _readBufferOffset - segmentStart;
            var atNewline = _readBufferOffset < _readBufferCount;
            try
            {
                utf8Bytes += encoder.GetByteCount(
                    _readBuffer,
                    segmentStart,
                    segmentLength,
                    flush: atNewline);
            }
            catch (ArgumentException exception)
            {
                throw new BrokerTransportException(
                    "The native installer returned invalid UTF-8 text.",
                    exception);
            }

            if (utf8Bytes > BrokerProtocol.MaxLineLength)
            {
                throw new BrokerTransportException("The native installer returned an oversized UI frame.");
            }

            if (segmentLength > 0)
            {
                builder.Append(_readBuffer, segmentStart, segmentLength);
            }

            if (atNewline)
            {
                // Consume LF but retain any following characters already read
                // into the buffer for the next frame.  CRLF is normalized to
                // the same line representation as StreamReader.ReadLineAsync.
                _readBufferOffset++;
                if (builder.Length > 0 && builder[builder.Length - 1] == '\r')
                {
                    builder.Length--;
                }
                return builder.ToString();
            }
        }
    }

    private async Task WriteFrameAsync(
        object frame,
        CancellationToken cancellationToken,
        bool permitBeforeHandshake = false,
        bool permitShutdown = false)
    {
        using var writeCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            _transportAbort.Token);
        await _writeGate.WaitAsync(writeCancellation.Token).ConfigureAwait(false);
        try
        {
            await WriteFrameUnderGateAsync(
                frame,
                writeCancellation.Token,
                permitBeforeHandshake,
                permitShutdown).ConfigureAwait(false);
        }
        finally
        {
            if (Volatile.Read(ref _writeGateReleaseUncertain) == 0)
            {
                _writeGate.Release();
            }
        }
    }

    private async Task WriteCommandFrameAsync(
        string operation,
        object payload,
        string requestId,
        CancellationToken cancellationToken)
    {
        using var writeCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            _transportAbort.Token);
        await _writeGate.WaitAsync(writeCancellation.Token).ConfigureAwait(false);
        try
        {
            BrokerRequest request;
            lock (_stateGate)
            {
                if (_terminalError is not null || _shutdownRequested)
                {
                    if (_terminalError is null)
                    {
                        throw new BrokerTransportException(
                            "The installer UI connection is closing.");
                    }
                    throw new BrokerTransportException(
                        "The installer UI connection is no longer available.",
                        _terminalError);
                }

                // Allocate and serialize under the write gate.  This makes
                // the strict native incoming-revision order match wire order
                // even when a cancel races another command.
                var revision = NextCommandRevisionLocked();
                request = new BrokerRequest(
                    BrokerProtocol.Schema,
                    "command",
                    BrokerProtocol.VersionString,
                    requestId,
                    _generation,
                    revision,
                    CreateCommandPayload(operation, payload));
            }

            await WriteFrameUnderGateAsync(request, writeCancellation.Token).ConfigureAwait(false);
        }
        finally
        {
            if (Volatile.Read(ref _writeGateReleaseUncertain) == 0)
            {
                _writeGate.Release();
            }
        }
    }

    private async Task WriteFrameUnderGateAsync(
        object frame,
        CancellationToken cancellationToken,
        bool permitBeforeHandshake = false,
        bool permitShutdown = false)
    {
        var line = JsonSerializer.Serialize(frame, SerializerOptions);
        if (line.Length == 0 || Encoding.UTF8.GetByteCount(line) > BrokerProtocol.MaxLineLength)
        {
            throw new BrokerTransportException("The installer UI frame is too large.");
        }

        lock (_stateGate)
        {
            if (!_started ||
                (!_handshakeComplete && !permitBeforeHandshake && !permitShutdown) ||
                (_shutdownRequested && !permitShutdown))
            {
                throw new BrokerTransportException("The native installer UI connection is unavailable.");
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        var writeStarted = false;
        try
        {
            writeStarted = true;
            var writeTask = _writer.WriteLineAsync(line.AsMemory(), cancellationToken);
            await AwaitWriteTaskAsync(writeTask, cancellationToken).ConfigureAwait(false);
            var flushTask = _writer.FlushAsync(cancellationToken);
            await AwaitWriteTaskAsync(flushTask, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            if (writeStarted)
            {
                Volatile.Write(ref _writeGateReleaseUncertain, 1);
                InvalidateTransport(exception);
                AbortTransport();
            }
            throw;
        }
    }

    private static async Task AwaitWriteTaskAsync(Task writeTask, CancellationToken cancellationToken)
    {
        try
        {
            await writeTask.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            _ = writeTask.ContinueWith(
                static completed => _ = completed.Exception,
                CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            throw;
        }
    }

    private void InvalidateTransport(Exception exception)
    {
        lock (_stateGate)
        {
            _terminalError ??= exception;
            _handshakeComplete = false;
            _initCompletion?.TrySetException(new BrokerTransportException(
                "The native installer did not complete its UI handshake.",
                exception));
        }

        try
        {
            _transportAbort.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
        FailPending(new BrokerTransportException(
            "The native installer stopped responding before the operation completed.",
            exception));
    }

    private void FailPending(Exception exception)
    {
        foreach (var pending in _pending.Values)
        {
            pending.TrySetException(exception);
        }
        _pending.Clear();
    }

    private void AbortTransport()
    {
        try
        {
            _transportAbort.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
        DisposeStreams();
    }

    private void DisposeStreams()
    {
        if (Interlocked.Exchange(ref _streamsClosed, 1) != 0)
        {
            return;
        }

        // Dispose the inherited stream facades before StreamWriter.Dispose.
        // Console.OpenStandard* does not transfer OS-handle ownership here;
        // this ordering only prevents a wrapper from attempting an unbounded
        // flush after shutdown has become terminal.
        try
        {
            _input.Dispose();
        }
        catch
        {
        }
        try
        {
            _output.Dispose();
        }
        catch
        {
        }
        try
        {
            _reader.Dispose();
        }
        catch
        {
        }
        try
        {
            _writer.Dispose();
        }
        catch
        {
        }
    }

    private static JsonElement CreateCommandPayload(string operation, object payload)
    {
        var source = JsonSerializer.SerializeToElement(payload, SerializerOptions);
        if (source.ValueKind != JsonValueKind.Object)
        {
            throw new BrokerTransportException("Installer operation payloads must be JSON objects.");
        }

        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        {
            ["operation"] = JsonSerializer.SerializeToElement(operation, SerializerOptions)
        };
        foreach (var property in source.EnumerateObject())
        {
            if (!string.Equals(property.Name, "operation", StringComparison.OrdinalIgnoreCase))
            {
                values[property.Name] = property.Value.Clone();
            }
        }
        return JsonSerializer.SerializeToElement(values, SerializerOptions);
    }

    private static void ValidateResponse(BrokerResponse response)
    {
        if (!string.Equals(response.Schema, BrokerProtocol.Schema, StringComparison.Ordinal) ||
            response.Version != BrokerProtocol.Version ||
            string.IsNullOrWhiteSpace(response.Type))
        {
            throw new BrokerTransportException("The native installer returned an incompatible UI frame.");
        }

        if (response.Type is "reply" or "error" && string.IsNullOrWhiteSpace(response.RequestId))
        {
            throw new BrokerTransportException("The native installer returned a reply without request identity.");
        }
    }

    private bool TryObserve(BrokerResponse response)
    {
        lock (_stateGate)
        {
            if (response.Generation < _generation ||
                (response.Generation == _generation && response.Revision < _revision))
            {
                return false;
            }

            if (response.Generation > _generation)
            {
                _generation = response.Generation;
                _revision = response.Revision;
            }
            else if (response.Revision > _revision)
            {
                _revision = response.Revision;
            }
            return true;
        }
    }

    // Caller must hold _stateGate.  The write gate is also held by every
    // outgoing frame path, which keeps this sequence ordered on the wire.
    private long NextCommandRevisionLocked()
    {
        var revision = Math.Max(_nextCommandRevision, _revision) + 1;
        _nextCommandRevision = revision;
        return revision;
    }

    private void RaiseEvent(BrokerResponse response)
    {
        try
        {
            EventReceived?.Invoke(this, response);
        }
        catch
        {
            // UI observers cannot terminate the transport reader.
        }
    }

    private void MarkTerminalFailure(Exception exception)
    {
        lock (_stateGate)
        {
            if (_shutdownRequested)
            {
                return;
            }
            _terminalError ??= exception;
            _handshakeComplete = false;
            _initCompletion?.TrySetException(new BrokerTransportException(
                "The native installer did not complete its UI handshake.", exception));
        }

        try
        {
            _transportAbort.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
        FailPending(new BrokerTransportException(
            "The native installer stopped responding.", exception));
    }
}
