using System;
using System.Threading;
using System.Threading.Tasks;

namespace Fullmag.Setup.UI.Broker;

public static class BrokerOperations
{
    public const string Preadmission = "preadmission";
    public const string Discover = "discover";
    public const string Prerequisites = "prerequisites";
    public const string Preview = "preview";
    public const string Commit = "commit";
    public const string Cancel = "cancel";
    public const string Setup = "initial_build";
    public const string LaunchUi = "launch_ui";
}
