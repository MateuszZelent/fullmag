with open('bench_fem_cpu_scaling.py', 'r') as f:
    content = f.read()

marker = '{"$mid":24,"mimeType":"cache_control","data":"ZXBoZW1lcmFs"}'
pos = content.find(marker)

if pos >= 0:
    clean_content = content[:pos]
    with open('bench_fem_cpu_scaling.py', 'w') as f:
        f.write(clean_content)
    print("Fixed")
else:
    print("Not found")
