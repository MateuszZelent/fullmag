using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using Fullmag.Setup.UI.Broker;
using Fullmag.Setup.UI.ViewModels;

namespace Fullmag.Setup.UI;

public partial class App : Application
{
    private static UiOptions _options = new(
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null);

    internal static void Configure(UiOptions options) => _options = options;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            var broker = _options.CreateBroker();
            var viewModel = new MainWindowViewModel(
                broker,
                _options.LoadLicenseText(),
                _options.InitialCheckoutPath,
                _options.InitialStorageRoot,
                _options.InitialLane,
                _options.SetupScript,
                _options.RequirementsManifest,
                _options.SetupHash,
                _options.ManifestHash);
            var window = new MainWindow
            {
                DataContext = viewModel
            };
            viewModel.FinishRequested += (_, _) => window.Close();
            desktop.MainWindow = window;
            _ = viewModel.InitializeAsync();
        }

        base.OnFrameworkInitializationCompleted();
    }
}
