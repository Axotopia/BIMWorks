import React, { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import * as THREE from 'three';
import { mountViewCube, mountAxisIcon } from './viewcube/viewcube';
import { threeCubeOptions } from './viewcube/viewcube-three';

export interface ViewCubeHandle {
  update: () => void;
  setVisible: (visible: boolean) => void;
}

export interface ViewCubeProps {
  cameraRef: React.MutableRefObject<THREE.Camera | null>;
  targetRef: React.MutableRefObject<THREE.Vector3>;
  sphericalRef: React.MutableRefObject<{ radius: number; theta: number; phi: number }>;
  updateCameraPosition: () => void;
  fitToExtents: () => void;
  corner?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  showAxes?: boolean;
  north?: number; // radians clockwise/counter-clockwise from +Y
}

export const ViewCube = forwardRef<ViewCubeHandle, ViewCubeProps>(
  (
    {
      cameraRef,
      targetRef,
      sphericalRef,
      updateCameraPosition,
      fitToExtents,
      corner = 'top-right',
      showAxes = true,
      north = 0,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const cubeApiRef = useRef<any>(null);
    const axesApiRef = useRef<any>(null);

    // Sync sphericalRef from camera position & target
    const syncSphericalFromCamera = () => {
      const cam = cameraRef.current;
      if (!cam) return;
      const t = targetRef.current;
      const relX = cam.position.x - t.x;
      const relY = cam.position.y - t.y;
      const relZ = cam.position.z - t.z;
      const radius = Math.hypot(relX, relY, relZ);
      if (radius > 1e-6) {
        sphericalRef.current.radius = radius;
        sphericalRef.current.phi = Math.acos(Math.max(-1, Math.min(1, relZ / radius)));
        sphericalRef.current.theta = Math.atan2(relX, relY);
      }
    };

    useEffect(() => {
      const host = containerRef.current;
      if (!host) return;

      const opts = threeCubeOptions({
        camera: () => cameraRef.current,
        controls: () => ({
          target: targetRef.current,
          update: () => {
            syncSphericalFromCamera();
            updateCameraPosition();
          },
        }),
        render: () => {
          syncSphericalFromCamera();
          updateCameraPosition();
        },
        home: () => {
          fitToExtents();
        },
        yUp: false, // Architectural Z-up
        corner,
        north,
      });

      const cube = mountViewCube(host, opts);
      cubeApiRef.current = cube;

      let axes: any = null;
      if (showAxes) {
        axes = mountAxisIcon(host, {
          getView: opts.getView,
          corner: 'bottom-left',
        });
        axesApiRef.current = axes;
      }

      return () => {
        opts.stop?.();
        cube?.destroy?.();
        axes?.destroy?.();
      };
    }, [cameraRef, targetRef, sphericalRef, updateCameraPosition, fitToExtents, corner, showAxes, north]);

    useImperativeHandle(
      ref,
      () => ({
        update: () => {
          cubeApiRef.current?.update?.();
          axesApiRef.current?.update?.();
        },
        setVisible: (visible: boolean) => {
          cubeApiRef.current?.setVisible?.(visible);
          axesApiRef.current?.setVisible?.(visible);
        },
      }),
      []
    );

    return <div ref={containerRef} className="absolute inset-0 pointer-events-none z-20 overflow-hidden" />;
  }
);

ViewCube.displayName = 'ViewCube';
