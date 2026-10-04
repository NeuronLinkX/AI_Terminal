'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isReadOnlyCommand, assessCommand } = require('../src/main/policy');

const RO = [
  // memory / cpu / gpu / disk / network inspection a server operator runs all day
  'free -m', 'free -h', 'vmstat', 'vmstat 1 5', 'iostat', 'iostat -x 1 3', 'mpstat', 'uptime', 'w', 'who -b', 'lscpu', 'lsblk', 'lspci | grep -i nvidia', 'lsmod | head',
  'nvidia-smi', 'nvidia-smi -q', 'nvidia-smi -L', 'nvidia-smi --query-gpu=name,utilization.gpu,memory.used --format=csv', 'nvidia-smi -i 0', 'nvidia-smi --id=GPU-abc123 -q', 'nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader',
  'rocm-smi --showuse --showmemuse', 'sensors', 'nproc', 'df -h', 'du -sh /var/log', 'ps aux | head', 'top -b -n 1', 'top -l 1', 'sleep 2',
  'hostname', 'hostname -f', 'date', 'date +%s', 'date -u', 'date -d "2 days ago"', 'timedatectl', 'timedatectl status', 'hostnamectl',
  'ifconfig', 'ifconfig -a', 'ifconfig en0', 'ip addr', 'ip a', 'ip -br link', 'ip route show', 'ip neigh', 'ss -tlnp', 'netstat -an | head',
  'dmesg | tail', 'dmesg -T', 'journalctl -n 50', 'journalctl -u nginx --since today --no-pager',
  'systemctl status ssh', 'systemctl is-active nginx', 'systemctl list-units --failed', 'systemctl show nginx', 'systemctl cat nginx', 'systemctl',
  'docker ps', 'docker ps -a', 'docker images', 'docker logs web', 'docker inspect web', 'docker stats --no-stream', 'docker container ls', 'docker volume ls', 'docker system df', 'podman ps',
  'kubectl get pods', 'kubectl get pods -n prod -o wide', 'kubectl describe pod x', 'kubectl logs x', 'kubectl top nodes', 'kubectl version',
  'tail -n 100 /var/log/syslog', 'cat /proc/meminfo', 'grep -c processor /proc/cpuinfo', 'cd /var/log && ls', 'uname -a', 'id', 'lsb_release -a',
];
const NOT_RO = [
  // they change the server, or never end and would block the shell
  'nvidia-smi -pm 1', 'nvidia-smi -r', 'nvidia-smi -pl 200', 'nvidia-smi -ac 5001,1590', 'nvidia-smi dmon', 'nvidia-smi pmon', 'nvidia-smi -l 1', 'nvidia-smi --gpu-reset', 'nvidia-smi -i', 'rocm-smi --setfan 100', 'rocm-smi --resetgpu',
  'vmstat 1', 'iostat 2', 'mpstat 1', 'free -s 1', 'top', 'top -d 1', 'tail -f /var/log/syslog', 'tail -F app.log', 'tail --follow x', 'journalctl -f', 'journalctl --vacuum-size=1M', 'journalctl --rotate', 'dmesg -c', 'dmesg -w', 'dmesg --clear',
  'systemctl restart nginx', 'systemctl stop ssh', 'systemctl enable x', 'systemctl daemon-reload', 'systemctl reboot', 'systemctl poweroff', 'systemctl disable --now x',
  'docker run -it ubuntu', 'docker rm web', 'docker rmi x', 'docker stop web', 'docker exec web ls', 'docker logs -f web', 'docker stats', 'docker system prune -af', 'docker container rm x', 'docker volume rm x', 'docker compose up',
  'kubectl delete pod x', 'kubectl apply -f x.yaml', 'kubectl exec -it x -- sh', 'kubectl logs -f x', 'kubectl get pods -w', 'kubectl get pods --watch', 'kubectl scale deploy x --replicas=0',
  'hostname newname', 'hostnamectl set-hostname x', 'date -s "2020-01-01"', 'date 010112002020', 'date --set=@1', 'timedatectl set-time 12:00', 'timedatectl set-timezone UTC',
  'ifconfig eth0 down', 'ifconfig eth0 up', 'ifconfig eth0 192.168.1.5', 'ip addr add 10.0.0.1/24 dev eth0', 'ip link set eth0 down', 'ip route del default', 'ip route flush all', 'ss -K', 'sensors -s',
  'sleep 100', 'sleep', 'ping 8.8.8.8', 'watch ls', 'sudo free', 'echo x > /tmp/f', 'cat /etc/passwd > /tmp/p',
  'free -m; reboot', 'uptime && systemctl restart x', 'ls | xargs rm',
];

test('server inspection commands are read-only: memory, CPU, GPU, disk, network, logs, services, containers', () => {
  for (const c of RO) assert.equal(isReadOnlyCommand(c), true, c);
});

test('…but the same programs with arguments that change the server, or that never end, are not', () => {
  for (const c of NOT_RO) assert.equal(isReadOnlyCommand(c), false, c);
});

test('a read-only inspection of a remote server needs no approval, a change always does, even when each looks harmless alone', () => {
  const remote = { home: '/home/ubuntu', blockNetwork: false };
  for (const c of ['nvidia-smi', 'free -m', 'systemctl status ssh', 'docker ps', 'journalctl -n 20']) {
    const v = assessCommand(c, '/home/ubuntu', 0, remote);
    assert.equal(v.level, 'allow', c);
    assert.equal(isReadOnlyCommand(c), true, c);
  }
  for (const c of ['sudo systemctl restart nginx', 'rm -rf /home/ubuntu/old', 'sudo reboot']) {
    const v = assessCommand(c, '/home/ubuntu', 0, remote);
    assert.notEqual(v.level, 'allow', c);
  }
});
