import { describe, expect, it } from "vitest";
import { parseMounts, readHostInfo } from "../src/hostinfo.js";

describe("readHostInfo", () => {
  it("returns the container-visible host details", () => {
    const info = readHostInfo();
    expect(info.hostname.length).toBeGreaterThan(0);
    expect(info.os.length).toBeGreaterThan(0);
    expect(info.kernel.length).toBeGreaterThan(0);
    expect(info.arch.length).toBeGreaterThan(0);
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.cpuCores).toBeGreaterThan(0);
    expect(info.cpuModel.length).toBeGreaterThan(0);
    expect(info.memoryTotalBytes).toBeGreaterThan(0);
    expect(info.hostOs === null || info.hostOs.length > 0).toBe(true);
    expect(Array.isArray(info.mounts)).toBe(true);
  });
});

describe("parseMounts", () => {
  it("returns physical device mounts with decoded whitespace", () => {
    const contents = [
      "devpts /dev/pts devpts rw,nosuid,noexec,relatime,gid=5,mode=620,ptmxmode=000 0 0",
      "/dev/nvme0n1p2 / ext4 rw,relatime,errors=remount-ro 0 0",
      "/dev/nvme0n1p1 /boot/efi vfat rw,relatime,fmask=0022 0 0",
      "/dev/nvme0n1p6 /home/pi5_nvme ext4 rw,relatime 0 0",
      "overlay / overlay rw,lowerdir=... 0 0",
      "/dev/sda1 /mnt/usb ext4 rw 0 0",
      "/dev/nvme0n1p6 /home/pi5_nvme ext4 rw,relatime 0 0",
    ].join("\n");
    expect(parseMounts(contents)).toEqual([
      { device: "/dev/nvme0n1p2", mount: "/", fs: "ext4" },
      { device: "/dev/nvme0n1p1", mount: "/boot/efi", fs: "vfat" },
      { device: "/dev/nvme0n1p6", mount: "/home/pi5_nvme", fs: "ext4" },
      { device: "/dev/sda1", mount: "/mnt/usb", fs: "ext4" },
    ]);
  });

  it("skips non-device (overlay/tmpfs) entries, decodes escapes, and removes duplicates", () => {
    const contents = [
      "overlay / overlay rw,lowerdir=/containers 0 0",
      "tmpfs /dev/shm tmpfs rw,mode=1777 0 0",
      "/dev/nvme0n1p6 /home/pi5\\040nvme ext4 rw,relatime 0 0",
      "/dev/nvme0n1p2 / ext4 rw 0 0",
      "/dev/nvme0n1p2 / ext4 rw 0 0",
    ].join("\n");
    expect(parseMounts(contents)).toEqual([
      { device: "/dev/nvme0n1p6", mount: "/home/pi5 nvme", fs: "ext4" },
      { device: "/dev/nvme0n1p2", mount: "/", fs: "ext4" },
    ]);
  });
});