
// compiled with:  g++ -std=c++17 -Wall -fno-omit-frame-pointer -g -O2 main.cpp
// profiled with:  perf record --call-graph dwarf -- ./a.out
// analyzed with:  perf report -g folded,0,caller,srcline,branch,count --no-children --full-source-path --stdio -i perf.data > perf.out

// output
#include <iostream>

// time related
#include <chrono>
#include <thread>

// network related
#include <sys/socket.h>
#include <netdb.h>
#include <unistd.h>

// other
#include <vector>
#include <cstring> // strlen


void simple_network_request() {
  int sock = socket(AF_INET, SOCK_STREAM, 0);
  struct hostent* host = gethostbyname("example.com");
  struct sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(80);
  addr.sin_addr = *((struct in_addr*)host->h_addr);
  connect(sock, (struct sockaddr*)&addr, sizeof(addr));

  const char* req = "GET / HTTP/1.0\r\nHost: example.com\r\n\r\n";
  send(sock, req, strlen(req), 0);

  char buf[4096] = {};
  recv(sock, buf, sizeof(buf), 0);
  close(sock);
}

int main() {
  
  // for loop
  auto start = std::chrono::high_resolution_clock::now();
  const unsigned int N = 10000000;

  std::vector<int> vec(N);
  for (unsigned int i = 0; i < N; ++i) {
    vec[i] = i;
  }
  vec.clear();

  auto end = std::chrono::high_resolution_clock::now();
  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
                .count();
  std::cout << "Time taken for for loop: " << ms << " ms" << std::endl;
  // about 150ms +- 20ms


  // block the main thread
  start = std::chrono::high_resolution_clock::now();

  std::this_thread::sleep_for(std::chrono::milliseconds(200));

  end = std::chrono::high_resolution_clock::now();
  ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
           .count();
  std::cout << "Time taken for sleep: " << ms << " ms" << std::endl;
  // about 200ms +- 10ms


  // threading
  start = std::chrono::high_resolution_clock::now();

  std::thread t([start]() {
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    auto end = std::chrono::high_resolution_clock::now();
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
             .count();
    std::cout << "(thread) Time taken for sleep: " << ms << " ms" << std::endl;
  });

  end = std::chrono::high_resolution_clock::now();
  ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
           .count();
  std::cout << "(main) Time taken for threaded sleep: " << ms << " ms" << std::endl;
  // 0ms

  t.join();
  // about 200ms +- 10ms


  // network request
  // make initial request to warm up DNS cache
  simple_network_request();

  start = std::chrono::high_resolution_clock::now();

  simple_network_request();

  end = std::chrono::high_resolution_clock::now();
  ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start)
           .count();
  std::cout << "Time taken for network request: " << ms << " ms" << std::endl;
  // about 40ms


  return 0;
}
