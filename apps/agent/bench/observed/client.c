#define _GNU_SOURCE
#include <sys/prctl.h>
#include <sys/wait.h>
#include <signal.h>
#include <time.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
static volatile sig_atomic_t done=0;
static void stop(int signal){(void)signal;done=1;}
static uint64_t ns(clockid_t clock){struct timespec t;clock_gettime(clock,&t);return (uint64_t)t.tv_sec*1000000000ull+(uint64_t)t.tv_nsec;}
int main(int argc,char **argv){
 if(argc>1 && strcmp(argv[1],"--version")==0){
  const char *delay=getenv("OBSERVED_VERSION_MS");
  if(delay){struct timespec wait={atoi(delay)/1000,(atoi(delay)%1000)*1000000L};nanosleep(&wait,0);}
  puts("codex-cli 0.0.0");return 0;
 }
 signal(SIGTERM,stop);signal(SIGINT,stop);
 sigset_t blocked,previous;
 sigemptyset(&blocked);sigaddset(&blocked,SIGTERM);sigaddset(&blocked,SIGINT);sigprocmask(SIG_BLOCK,&blocked,&previous);
 int noise=argc>1 && strcmp(argv[1],"--noise")==0;
 if(noise)prctl(PR_SET_NAME,"fixture-owner",0,0,0);
 int count=argc>1+noise?atoi(argv[1+noise]):0;pid_t children[128];if(count>128)return 2;
 for(int i=0;i<count;i++){pid_t pid=fork();if(pid==0){prctl(PR_SET_NAME,"tool-sleeper",0,0,0);while(!done)sigsuspend(&previous);return 0;}if(pid<0)return 3;children[i]=pid;}
 sigprocmask(SIG_SETMASK,&previous,0);
 uint64_t origin=ns(CLOCK_MONOTONIC);
 while(!done){uint64_t phase=(ns(CLOCK_MONOTONIC)-origin)%15000000000ull;uint64_t budget=getenv("OBSERVED_IDLE")?0ull:5000000ull;if(getenv("OBSERVED_UI"))budget=(phase>=5000000000ull&&phase<5100000000ull)?100000000ull:0ull;uint64_t start=ns(CLOCK_THREAD_CPUTIME_ID);volatile uint64_t value=1;while(!done&&ns(CLOCK_THREAD_CPUTIME_ID)-start<budget)value=value*1664525u+1013904223u;struct timespec wait={0,95000000};nanosleep(&wait,0);}
 for(int i=0;i<count;i++)kill(children[i],SIGTERM);
 for(int i=0;i<count;i++)waitpid(children[i],0,0);
 return 0;
}
