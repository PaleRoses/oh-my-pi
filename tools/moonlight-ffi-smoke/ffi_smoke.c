#include "moonlight_triangulation.h"

#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int require_ok(
  const char *operation,
  ml_status status,
  const ml_obstruction *obstruction
) {
  if (status == ML_STATUS_OK) {
    return 1;
  }

  fprintf(
    stderr,
    "%s failed: status=%" PRIu32 " obstruction=%" PRIu32
    " coordinate_error=%" PRIu32 " input=%" PRIu64
    " first=%" PRIu64 " second=%" PRIu64 " message=%s\n",
    operation,
    status,
    obstruction->code,
    obstruction->coordinate_error,
    obstruction->input_index,
    obstruction->first_index,
    obstruction->second_index,
    obstruction->message
  );
  return 0;
}

int main(void) {
  ml_obstruction obstruction = {0};
  ml_mesh *mesh = NULL;
  ml_region *left = NULL;
  ml_region *right = NULL;
  ml_region *intersection = NULL;
  double *vertices = NULL;
  uint32_t *triangles = NULL;
  int exit_code = EXIT_FAILURE;

  if (!require_ok("ml_runtime_initialize", ml_runtime_initialize(), &obstruction)) {
    goto cleanup;
  }

  const uint32_t abi_version = ml_abi_version();
  printf("abi_version=%" PRIu32 "\n", abi_version);
  if (abi_version != 2) {
    fprintf(stderr, "unexpected ABI version\n");
    goto cleanup;
  }

  const double sites[] = {
    0.0, 0.0,
    2.0, 0.0,
    2.0, 2.0,
    0.0, 2.0,
    1.0, 1.0
  };

  if (!require_ok(
        "ml_delaunay_f64",
        ml_delaunay_f64(sites, 5, &mesh, &obstruction),
        &obstruction)) {
    goto cleanup;
  }

  size_t vertex_count = 0;
  size_t triangle_count = 0;
  if (!require_ok(
        "ml_mesh_vertex_count",
        ml_mesh_vertex_count(mesh, &vertex_count, &obstruction),
        &obstruction)
      || !require_ok(
        "ml_mesh_triangle_count",
        ml_mesh_triangle_count(mesh, &triangle_count, &obstruction),
        &obstruction)) {
    goto cleanup;
  }

  printf("mesh_vertices=%zu mesh_triangles=%zu\n", vertex_count, triangle_count);
  if (vertex_count != 5 || triangle_count != 4) {
    fprintf(stderr, "unexpected Delaunay cardinality\n");
    goto cleanup;
  }

  vertices = calloc(vertex_count * 2, sizeof(*vertices));
  triangles = calloc(triangle_count * 3, sizeof(*triangles));
  if (vertices == NULL || triangles == NULL) {
    fprintf(stderr, "allocation failed\n");
    goto cleanup;
  }

  size_t vertices_written = 0;
  size_t triangles_written = 0;
  if (!require_ok(
        "ml_mesh_copy_vertices_f64",
        ml_mesh_copy_vertices_f64(
          mesh,
          vertices,
          vertex_count,
          &vertices_written,
          &obstruction),
        &obstruction)
      || !require_ok(
        "ml_mesh_copy_triangles_u32",
        ml_mesh_copy_triangles_u32(
          mesh,
          triangles,
          triangle_count,
          &triangles_written,
          &obstruction),
        &obstruction)) {
    goto cleanup;
  }

  printf("vertices_written=%zu triangles_written=%zu\n", vertices_written, triangles_written);
  for (size_t triangle = 0; triangle < triangles_written; ++triangle) {
    printf(
      "triangle[%zu]=%" PRIu32 ",%" PRIu32 ",%" PRIu32 "\n",
      triangle,
      triangles[triangle * 3],
      triangles[triangle * 3 + 1],
      triangles[triangle * 3 + 2]
    );
  }

  const double left_coordinates[] = {
    0.0, 0.0,
    2.0, 0.0,
    2.0, 2.0,
    0.0, 2.0
  };
  const double right_coordinates[] = {
    1.0, 0.0,
    3.0, 0.0,
    3.0, 2.0,
    1.0, 2.0
  };
  const size_t loop_point_counts[] = {4};
  const size_t component_loop_counts[] = {1};

  if (!require_ok(
        "ml_region_create_f64(left)",
        ml_region_create_f64(
          left_coordinates,
          4,
          loop_point_counts,
          1,
          component_loop_counts,
          1,
          &left,
          &obstruction),
        &obstruction)
      || !require_ok(
        "ml_region_create_f64(right)",
        ml_region_create_f64(
          right_coordinates,
          4,
          loop_point_counts,
          1,
          component_loop_counts,
          1,
          &right,
          &obstruction),
        &obstruction)
      || !require_ok(
        "ml_region_intersection",
        ml_region_intersection(left, right, &intersection, &obstruction),
        &obstruction)) {
    goto cleanup;
  }

  int64_t euler_characteristic = 0;
  char area_ratio[128] = {0};
  size_t area_bytes_written = 0;
  double perimeter_lower = 0.0;
  double perimeter_upper = 0.0;
  if (!require_ok(
        "ml_region_measure",
        ml_region_measure(
          intersection,
          &euler_characteristic,
          area_ratio,
          sizeof(area_ratio),
          &area_bytes_written,
          &perimeter_lower,
          &perimeter_upper,
          &obstruction),
        &obstruction)) {
    goto cleanup;
  }

  ml_region_location location = ML_REGION_EXTERIOR;
  if (!require_ok(
        "ml_region_locate_point_f64",
        ml_region_locate_point_f64(
          intersection,
          1.5,
          1.0,
          &location,
          &obstruction),
        &obstruction)) {
    goto cleanup;
  }

  printf(
    "intersection_euler=%" PRId64
    " area=%s area_bytes=%zu perimeter=[%.17g,%.17g] location=%" PRIu32 "\n",
    euler_characteristic,
    area_ratio,
    area_bytes_written,
    perimeter_lower,
    perimeter_upper,
    location
  );

  if (euler_characteristic != 1
      || strcmp(area_ratio, "2/1") != 0
      || location != ML_REGION_INTERIOR
      || !(perimeter_lower <= 6.0 && perimeter_upper >= 6.0)) {
    fprintf(stderr, "unexpected exact-region result\n");
    goto cleanup;
  }

  puts("ffi_smoke=PASS");
  exit_code = EXIT_SUCCESS;

cleanup:
  free(triangles);
  free(vertices);
  if (intersection != NULL) {
    ml_region_free(intersection);
  }
  if (right != NULL) {
    ml_region_free(right);
  }
  if (left != NULL) {
    ml_region_free(left);
  }
  if (mesh != NULL) {
    ml_mesh_free(mesh);
  }
  return exit_code;
}
