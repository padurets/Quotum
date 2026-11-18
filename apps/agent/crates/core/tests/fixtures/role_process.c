/* A local metadata stand-in. It blocks on stdin and never starts tools or clients. */
#include <stdio.h>
#include <sys/prctl.h>

int main(void) {
    if (prctl(PR_SET_NAME, "codex", 0, 0, 0) != 0) return 1;
    setvbuf(stdout, NULL, _IONBF, 0);
    puts("ready");
    int command;
    while ((command = getchar()) != EOF) {
        if (command == 'd') {
            if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) return 2;
            puts("denied");
        } else if (command == 'r') {
            if (prctl(PR_SET_DUMPABLE, 1, 0, 0, 0) != 0) return 3;
            puts("restored");
        }
    }
    return 0;
}
