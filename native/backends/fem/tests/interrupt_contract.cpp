/*
 * interrupt_contract.cpp - native FEM cooperative interrupt hook contracts.
 */

#include "context.hpp"

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace fullmag::fem {
bool poll_interrupt(Context &ctx);
void set_interrupt_poll(
    Context &ctx,
    fullmag_fem_interrupt_poll_fn poll_fn,
    void *user_data);
}

namespace {

void check(bool condition, const char *msg) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", msg);
        std::exit(1);
    }
}

std::string read_text_file(const std::filesystem::path &path) {
    std::ifstream in(path);
    if (!in) {
        std::fprintf(stderr, "FAIL: unable to read %s\n", path.string().c_str());
        std::exit(1);
    }
    std::ostringstream buffer;
    buffer << in.rdbuf();
    return buffer.str();
}

std::filesystem::path fem_source_root() {
    const std::filesystem::path this_file(__FILE__);
    if (this_file.is_absolute()) {
        return this_file.parent_path().parent_path();
    }
    return std::filesystem::current_path() / this_file.parent_path().parent_path();
}

int interrupt_requested(void *) {
    return 1;
}

int interrupt_not_requested(void *) {
    return 0;
}

void cooperative_interrupt_hook_is_owned_by_runtime_module() {
    const std::filesystem::path root = fem_source_root();
    const std::string context_header = read_text_file(root / "include" / "context.hpp");
    const std::string interrupt_header =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "interrupt.hpp");
    const std::string interrupt_source =
        read_text_file(root / "cpu" / "mfem" / "runtime" / "interrupt.cpp");
    const std::string api = read_text_file(root / "src" / "api.cpp");

    check(
        context_header.find("inline bool poll_interrupt(") == std::string::npos,
        "cooperative interrupt polling must not be defined inline in context.hpp");
    check(
        interrupt_header.find("Poll the native FEM cooperative interrupt hook") !=
            std::string::npos,
        "interrupt runtime header must document cooperative polling ownership");
    check(
        interrupt_header.find("struct InterruptRuntimeState") != std::string::npos,
        "interrupt runtime header must declare the runtime interrupt state owner");
    check(
        interrupt_header.find("fullmag_fem_interrupt_poll_fn poll") != std::string::npos &&
            interrupt_header.find("void *user_data") != std::string::npos &&
            interrupt_header.find("bool step_interrupted") != std::string::npos,
        "Interrupt runtime state must own callback, user data, and interrupted latch");
    check(
        context_header.find("InterruptRuntimeState interrupt{}") != std::string::npos,
        "Context must store cooperative interrupt state under interrupt");
    for (const char *flat_field : {
             "fullmag_fem_interrupt_poll_fn interrupt_poll",
             "void *interrupt_poll_user_data",
             "bool step_interrupted",
         }) {
        check(
            context_header.find(flat_field) == std::string::npos,
            "Context must not own flat cooperative interrupt fields");
    }
    check(
        interrupt_source.find("bool poll_interrupt(Context &ctx)") != std::string::npos,
        "cooperative interrupt polling must be defined in runtime/interrupt.cpp");
    check(
        interrupt_header.find("Install the native FEM cooperative interrupt hook") !=
            std::string::npos,
        "interrupt runtime header must document callback installation ownership");
    check(
        interrupt_source.find("void set_interrupt_poll(") != std::string::npos,
        "cooperative interrupt callback installation must be defined in runtime/interrupt.cpp");
    check(
        api.find("handle->context.interrupt.poll =") == std::string::npos &&
            api.find("handle->context.interrupt.user_data =") == std::string::npos,
        "C ABI facade must not mutate interrupt runtime state directly");
    check(
        api.find("fullmag::fem::set_interrupt_poll(") != std::string::npos,
        "C ABI facade must delegate interrupt callback installation to runtime module");
}

void poll_interrupt_sets_interrupted_state_only_when_requested() {
    fullmag::fem::Context ctx;

    check(
        !fullmag::fem::poll_interrupt(ctx),
        "missing interrupt hook is not interrupted");
    check(!ctx.interrupt.step_interrupted, "missing interrupt hook leaves state clear");

    ctx.interrupt.poll = interrupt_not_requested;
    check(
        !fullmag::fem::poll_interrupt(ctx),
        "zero-returning interrupt hook is not interrupted");
    check(!ctx.interrupt.step_interrupted, "zero-returning interrupt hook leaves state clear");

    ctx.interrupt.poll = interrupt_requested;
    check(
        fullmag::fem::poll_interrupt(ctx),
        "nonzero interrupt hook reports interruption");
    check(ctx.interrupt.step_interrupted, "nonzero interrupt hook sets interrupted state");
}

void set_interrupt_poll_updates_callback_and_user_data() {
    fullmag::fem::Context ctx;
    void *user_data = reinterpret_cast<void *>(0x1234);

    fullmag::fem::set_interrupt_poll(ctx, interrupt_requested, user_data);
    check(ctx.interrupt.poll == interrupt_requested, "interrupt setter installs callback");
    check(ctx.interrupt.user_data == user_data, "interrupt setter installs user data");
}

} // namespace

int main() {
    cooperative_interrupt_hook_is_owned_by_runtime_module();
    poll_interrupt_sets_interrupted_state_only_when_requested();
    set_interrupt_poll_updates_callback_and_user_data();
    return 0;
}
