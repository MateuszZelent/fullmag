using System;
using System.Collections.ObjectModel;
using System.Text.Json;

namespace Fullmag.Setup.UI.ViewModels;

public enum WizardPageId
{
    Welcome,
    License,
    Paths,
    Environment,
    Requirements,
    Progress,
    Ready
}

public sealed class WizardStepViewModel : ObservableObject
{
    private bool _isCurrent;
    private bool _isCompleted;
    private bool _canNavigate;

    public WizardStepViewModel(int number, WizardPageId id, string title, string description)
    {
        Number = number;
        Id = id;
        Title = title;
        Description = description;
    }

    public int Number { get; }
    public WizardPageId Id { get; }
    public string Title { get; }
    public string Description { get; }
    public string AutomationId => $"wizard-step-{Id.ToString().ToLowerInvariant()}";

    public bool IsCurrent
    {
        get => _isCurrent;
        set => SetProperty(ref _isCurrent, value);
    }

    public bool IsCompleted
    {
        get => _isCompleted;
        set => SetProperty(ref _isCompleted, value);
    }

    public bool CanNavigate
    {
        get => _canNavigate;
        set => SetProperty(ref _canNavigate, value);
    }
}

public sealed class WizardPageViewModel
{
    public WizardPageViewModel(MainWindowViewModel owner, WizardPageId id, string title, string subtitle)
    {
        Owner = owner;
        Id = id;
        Title = title;
        Subtitle = subtitle;
    }

    public MainWindowViewModel Owner { get; }
    public WizardPageId Id { get; }
    public string Title { get; }
    public string Subtitle { get; }

    public bool IsWelcome => Id == WizardPageId.Welcome;
    public bool IsLicense => Id == WizardPageId.License;
    public bool IsPaths => Id == WizardPageId.Paths;
    public bool IsEnvironment => Id == WizardPageId.Environment;
    public bool IsRequirements => Id == WizardPageId.Requirements;
    public bool IsProgress => Id == WizardPageId.Progress;
    public bool IsReady => Id == WizardPageId.Ready;
}

public sealed class EnvironmentFieldViewModel : ObservableObject
{
    private string _value;
    private bool _isDirty;

    public EnvironmentFieldViewModel(
        string key,
        bool secret,
        bool present,
        string? value,
        bool isDirty = false)
    {
        Key = key;
        IsSecret = secret;
        IsPresent = present;
        _value = value ?? string.Empty;
        _isDirty = isDirty;
    }

    public string Key { get; }
    public string Label => Key.Replace('_', ' ');
    public string AutomationId => $"environment-field-{Key.ToLowerInvariant().Replace('_', '-')}";
    public bool IsSecret { get; }
    public bool IsPresent { get; }
    public char PasswordChar => IsSecret ? '●' : '\0';
    public bool IsDirty => _isDirty;

    public string Value
    {
        get => _value;
        set
        {
            var next = value ?? string.Empty;
            if (SetProperty(ref _value, next))
            {
                _isDirty = true;
                RaisePropertyChanged(nameof(IsDirty));
            }
        }
    }
}

public sealed class RequirementCheckViewModel : ObservableObject
{
    private string _state;
    private string _details;

    public RequirementCheckViewModel(string name, string state, string details)
    {
        Name = name;
        _state = state;
        _details = details;
    }

    public string Name { get; }

    public string State
    {
        get => _state;
        set => SetProperty(ref _state, value);
    }

    public string Details
    {
        get => _details;
        set => SetProperty(ref _details, value);
    }

    public bool IsReady => string.Equals(State, "ready", StringComparison.OrdinalIgnoreCase) ||
                           string.Equals(State, "complete", StringComparison.OrdinalIgnoreCase);
}

internal static class JsonPayload
{
    public static string FirstString(JsonElement payload, params string[] propertyNames)
    {
        foreach (var propertyName in propertyNames)
        {
            var value = String(payload, propertyName);
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }
        return string.Empty;
    }

    public static string String(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(propertyName, out var value) ||
            value.ValueKind != JsonValueKind.String)
        {
            return string.Empty;
        }

        return value.GetString() ?? string.Empty;
    }

    public static string NestedString(JsonElement payload, string propertyName, string nestedPropertyName)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(propertyName, out var value) ||
            value.ValueKind != JsonValueKind.Object)
        {
            return string.Empty;
        }

        return String(value, nestedPropertyName);
    }

    public static string NestedObjectString(
        JsonElement payload,
        string objectPropertyName,
        string nestedObjectPropertyName,
        string valuePropertyName)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(objectPropertyName, out var value) ||
            value.ValueKind != JsonValueKind.Object ||
            !value.TryGetProperty(nestedObjectPropertyName, out var nested) ||
            nested.ValueKind != JsonValueKind.Object)
        {
            return string.Empty;
        }

        return String(nested, valuePropertyName);
    }

    public static bool Bool(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(propertyName, out var value) ||
            (value.ValueKind != JsonValueKind.True && value.ValueKind != JsonValueKind.False))
        {
            return false;
        }

        return value.GetBoolean();
    }

    public static int? Int(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty(propertyName, out var value) ||
            value.ValueKind != JsonValueKind.Number ||
            !value.TryGetInt32(out var result))
        {
            return null;
        }

        return result;
    }
}
