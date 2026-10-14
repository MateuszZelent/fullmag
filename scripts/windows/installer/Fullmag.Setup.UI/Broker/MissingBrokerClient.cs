using System;
using System.Threading;
using System.Threading.Tasks;

namespace Fullmag.Setup.UI.Broker;

internal sealed class MissingBrokerClient : IBrokerClient
{
    public event EventHandler<BrokerResponse>? EventReceived;

    public Task StartAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task<BrokerResponse> SendAsync(
        string operation,
        object payload,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(BrokerResponse.Blocked(
            Guid.NewGuid().ToString("D"),
            "No trusted installer broker was configured; installation is blocked."));

    public Task ShutdownAsync() => Task.CompletedTask;

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
