#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static int held_child(void *unused) {
    (void)unused;
    const char ready[] = "{\"status\":\"fixture-wait-held\"}\n";
    if (write(STDOUT_FILENO, ready, sizeof ready - 1) != sizeof ready - 1) _exit(11);
    char gate = 0;
    ssize_t n;
    do { n = read(STDIN_FILENO, &gate, 1); } while (n < 0 && errno == EINTR);
    _exit(n == 1 && gate == 'r' ? 0 : 12);
}

/* The calling main thread waits in the kernel until the gated child exits. */
int quotum_fixture_wait(void) {
    size_t size = 1024 * 1024;
    char *stack = malloc(size);
    if (!stack) return 3;
    pid_t child = clone(held_child, stack + size, CLONE_VM | CLONE_VFORK | SIGCHLD, NULL);
    if (child < 0) { free(stack); return 4; }
    int status = 0;
    pid_t reaped;
    do { reaped = waitpid(child, &status, 0); } while (reaped < 0 && errno == EINTR);
    free(stack);
    return reaped == child && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 5;
}
